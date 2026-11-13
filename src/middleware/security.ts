import compression from 'compression';
import cors from 'cors';
import type { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import type { Env } from '../config/env.ts';
import { forbidden } from '../shared/problem.ts';

export const securityHeaders = (env: Env): RequestHandler =>
  helmet({
    contentSecurityPolicy:
      env.NODE_ENV === 'production'
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
    hsts: env.NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
    noSniff: true,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

export const corsMiddleware = (env: Env): RequestHandler =>
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false);
        return;
      }
      callback(null, env.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-None-Match',
      'X-Request-Id',
      'X-API-Key',
      'X-Debug-Slow',
      'Last-Event-ID',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'ETag',
    ],
    maxAge: 600,
  });

export const compressionMiddleware = (): RequestHandler => compression({ threshold: 1024 });

export const applySecurity = (app: Express, env: Env): void => {
  app.use(securityHeaders(env));
  app.use(corsMiddleware(env));
  app.use(compressionMiddleware());
};

export const assertOriginAllowed = (env: Env, origin: string | undefined): void => {
  if (!origin) return;
  if (!env.CORS_ORIGINS.includes(origin)) throw forbidden('Origin is not allowed');
};
