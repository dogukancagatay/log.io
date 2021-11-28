import express from 'express'
import basicAuth from 'express-basic-auth'
import http from 'http'
import net from 'net'
import path from 'path'
import socketio from 'socket.io'
import InputRegistry from './inputs'
import { MessageHandlers, ServerConfig } from './types'
import getLogger from './logger'
// @ts-ignore
import SyslogServer from 'syslog-server'

var logger = getLogger('server')

// File path to UI app build artifacts (static JS/CSS/HTML)
const UI_BUILD_PATH = process.env.LOGIO_SERVER_UI_BUILD_PATH
  || path.resolve(__dirname, 'ui')

/**
 * Broadcast an inbound message to socket.io channels
 */
async function handleNewMessage(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const msg = msgParts.slice(3).join('|')
  const inputName = inputs.add(stream, source)

  // Broadcast message to input channel
  io.to(inputName).emit(mtype, {
    inputName,
    msg,
    stream,
    source,
  })

  // Broadcast ping to all browsers
  io.emit('+ping', { inputName, stream, source })
  if (config.debug) {
    logger.debug(msgParts.join('|'))
  }
}

/**
 * Broadcast a new input coming online to all browsers
 */
async function handleRegisterInput(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const inputName = inputs.add(stream, source)
  io.emit(mtype, { stream, source, inputName })
}

/**
 * Broadcast an input going offline to all browsers
 */
async function handleDeregisterInput(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const inputName = inputs.remove(stream, source)
  io.emit(mtype, { stream, source, inputName })
}

// Maps TCP message prefix to handler function
const messageHandlers: MessageHandlers = {
  '+msg': handleNewMessage,
  '+input': handleRegisterInput,
  '-input': handleDeregisterInput,
}

/**
 * Broadcast an inbound message to socket.io channels
 */
async function broadcastMessage(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  data: Buffer,
): Promise<void> {
  // Parse raw message into parts
  // NOTE: After split on null termination character, last item will always
  // be either an empty string or a partial/incomplete message
  const msgs = data.toString()
    .split('\0')
    .slice(0, -1)
    .filter((msg) => !!msg.trim())
  msgs.forEach(async (msg) => {
    const msgParts = msg.split('|')
    const messageHandler = messageHandlers[msgParts[0]]
    if (messageHandler) {
      await messageHandler(config, inputs, io, msgParts)
    } else {
      logger.error(`Unknown message type: ${msgParts[0]}`)
    }
  })
}

/**
 * Start message & web servers
 */
async function main(config: ServerConfig): Promise<void> {
  // Create HTTP server w/ static file serving, socket.io bindings & basic auth
  const server = express()
  const httpServer = new http.Server(server)
  const io = socketio(httpServer)
  const inputs = new InputRegistry()
  const syslogServer = new SyslogServer();

  if (config.debug) {
    logger.level = "debug"
    logger.debug("Debug enabled")
  }

  if (config.basicAuth) {
    if (config.basicAuth.users && config.basicAuth.realm) {
      server.use(basicAuth({
        ...config.basicAuth,
        challenge: true,
      }))
    } else {
      logger.warn(`
WARNING: Unable to enable basic authentication.

Basic auth configuration requires the following keys: 'users', 'realm'.

See README for more examples.
      `)
    }
  }
  server.use('/', express.static(UI_BUILD_PATH))

  // Create TCP message server
  const messageServer = net.createServer(async (socket: net.Socket) => {
    socket.on('data', async (data: Buffer) => {
      await broadcastMessage(config, inputs, io, data)
    })
  })

  // When a new browser connects, register stream activation events
  io.on('connection', async (socket: SocketIO.Socket) => {
    // Send existing inputs to browser
    inputs.getInputs().forEach((input) => {
      socket.emit('+input', input)
    })
    // Register input activation events
    socket.on('+activate', (inputName) => {
      socket.join(inputName)
    })
    socket.on('-activate', (inputName) => {
      socket.leave(inputName)
    })
  })

  syslogServer.on('message', (value : any) => {
    broadcastMessage(config, inputs, io, Buffer.from('+msg|syslog|localhost|' + value.message + '\0', 'utf-8'))
  });

  // Start listening for requests
  messageServer.listen(config.messageServer.port, config.messageServer.host, () => {
    logger.info(`TCP message server listening on port ${config.messageServer.port}`)

    // register syslog input
    broadcastMessage(config, inputs, io, Buffer.from('+input|syslog|localhost\0', 'utf-8'))
  })

  httpServer.listen(config.httpServer.port, config.httpServer.host, () => {
    logger.info(`HTTP server listening on port ${config.httpServer.port}`)
  })

  syslogServer.start({port: config.syslogServer.port, address: config.syslogServer.host}, () => {
    logger.info(`Syslog server listening on port ${config.syslogServer.port}`)
  });
}

export default main
