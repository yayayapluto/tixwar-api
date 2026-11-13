import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.ts';
import { badRequest } from '../shared/problem.ts';

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const createSlowMotionMiddleware = (env: Env) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('x-debug-slow');
    if (!header) {
      next();
      return;
    }
    if (!env.DEBUG_ENABLED) {
      next();
      return;
    }
    if (req.principal?.role !== 'admin') {
      next(badRequest('X-Debug-Slow requires an authenticated admin'));
      return;
    }
    const delay = Number(header);
    if (!Number.isFinite(delay) || delay < 0 || delay > 5000) {
      next(badRequest('X-Debug-Slow must be between 0 and 5000 milliseconds'));
      return;
    }
    await sleep(delay);
    next();
  };
};
