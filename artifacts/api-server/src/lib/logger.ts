import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      // Outgoing axios error objects: strip auth headers and raw request strings
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.config.headers["api-key"]',
      'err.config.headers["xi-api-key"]',
      'err.config.headers["Ocp-Apim-Subscription-Key"]',
      'err.request._header',
      'err.response.config.headers.Authorization',
      'err.response.config.headers.authorization',
      'err.response.config.headers["api-key"]',
      'err.response.config.headers["xi-api-key"]',
      'err.response.config.headers["Ocp-Apim-Subscription-Key"]',
      'err.response.request._header',
    ],
    censor: "[REDACTED]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
