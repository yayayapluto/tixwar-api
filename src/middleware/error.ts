import type { NextFunction, Request, Response } from 'express';
import { MongoServerError } from 'mongodb';
import { ZodError } from 'zod';
import { captureError } from '../infra/sentry.ts';
import { createLogger } from '../shared/logger.ts';
import { AppError, internalError, toProblem } from '../shared/problem.ts';

const logger = createLogger('http-error');

const isBodyParserError = (
  error: unknown,
): error is { type: string; status: number; message: string } =>
  typeof error === 'object' &&
  error !== null &&
  'type' in error &&
  typeof error.type === 'string' &&
  error.type.startsWith('entity.');

const mapError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Bad Request',
      detail: 'Request validation failed',
      errors: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }

  if (isBodyParserError(error)) {
    const status = error.type === 'entity.too.large' ? 413 : 400;
    return new AppError({
      status,
      code: 'VALIDATION_FAILED',
      title: status === 413 ? 'Payload Too Large' : 'Bad Request',
      detail: error.message,
    });
  }

  if (error instanceof MongoServerError) {
    if (error.code === 11000) {
      return new AppError({
        status: 409,
        code: 'CONFLICT',
        title: 'Conflict',
        detail: 'Resource already exists',
      });
    }
    if (error.code === 121) {
      return new AppError({
        status: 400,
        code: 'VALIDATION_FAILED',
        title: 'Bad Request',
        detail: 'Document failed database schema validation',
      });
    }
  }

  return internalError();
};

export const notFoundHandler = (req: Request, res: Response): void => {
  const problem = toProblem(
    new AppError({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not Found',
      detail: `Route ${req.method} ${req.path} does not exist`,
    }),
    req.originalUrl,
    req.requestId,
  );
  res.status(404).type('application/problem+json').json(problem);
};

export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const appError = mapError(error);

  if (appError.status >= 500) {
    logger.error({ err: error, requestId: req.requestId, path: req.originalUrl }, 'request failed');
    captureError(error);
  } else {
    logger.debug(
      { code: appError.code, requestId: req.requestId, path: req.originalUrl },
      'request rejected',
    );
  }

  if (res.headersSent) return;

  const problem = toProblem(appError, req.originalUrl, req.requestId);
  if (appError.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }
  res.status(appError.status).type('application/problem+json').json(problem);
};
