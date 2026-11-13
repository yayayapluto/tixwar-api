import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

export interface ValidatedRequest extends Request {
  validated?: {
    body?: unknown;
    query?: unknown;
    params?: unknown;
  };
}

export const validate =
  <T extends { body?: ZodType; query?: ZodType; params?: ZodType }>(schemas: T): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      const target = req as ValidatedRequest;
      target.validated ??= {};
      if (schemas.params) target.validated.params = schemas.params.parse(req.params);
      if (schemas.query) target.validated.query = schemas.query.parse(req.query);
      if (schemas.body) target.validated.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      next(error);
    }
  };

export const validated = <T>(req: Request, key: 'body' | 'query' | 'params'): T => {
  const target = req as ValidatedRequest;
  const value = target.validated?.[key];
  if (value === undefined) throw new Error(`request ${key} was not validated`);
  return value as T;
};
