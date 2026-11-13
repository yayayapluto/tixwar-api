import { type LoggerOptions, pino } from 'pino';
import { getEnv } from '../config/env.ts';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.passwordHash',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
];

export const createLogger = (serviceName?: string): pino.Logger => {
  const env = getEnv();
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: serviceName ?? env.SERVICE_NAME, env: env.NODE_ENV },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(options);
};

export type AppLogger = pino.Logger;
