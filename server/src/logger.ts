import * as log4js from 'log4js';

log4js.configure({
  appenders: {
    console: {
      type: "console",
    },
  },
  categories: {
    default: {
      appenders: ["console"],
      level: "info",
    },
  },
});

function getLogger(category: string) : log4js.Logger {
  return log4js.getLogger(category)
}

export default getLogger
