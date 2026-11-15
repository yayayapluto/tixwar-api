import * as Sentry from '@sentry/bun';
import { getEnv } from '../config/env.ts';
import { createLogger } from '../shared/logger.ts';

const logger = createLogger('sentry');

let initialized = false;

export const initSentry = (): void => {
  const env = getEnv();
  if (!env.SENTRY_DSN || initialized) return;
  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: 1.0,
    });
    initialized = true;
    logger.info('sentry initialized');
  } catch (error) {
    logger.warn({ err: error }, 'sentry failed to initialize');
  }
};

export const captureError = (error: unknown): void => {
  if (!initialized) return;
  try {
    Sentry.captureException(error);
  } catch {
    // error reporting must never break request handling
  }
};

initSentry();
