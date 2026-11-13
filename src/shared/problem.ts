export const DOMAIN_ERROR_CODES = [
  'SOLD_OUT',
  'SALE_NOT_STARTED',
  'SALE_ENDED',
  'LIMIT_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'ORDER_EXPIRED',
  'DEPENDENCY_UNAVAILABLE',
  'INVALID_STATE_TRANSITION',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UNAVAILABLE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface FieldError {
  field: string;
  message: string;
  value?: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  code: DomainErrorCode;
  errors?: FieldError[];
  retryAfterSeconds?: number;
}

const PROBLEM_TYPE_BASE = 'https://tixwar.dev/problems';

export class AppError extends Error {
  readonly status: number;
  readonly code: DomainErrorCode;
  readonly title: string;
  readonly errors?: FieldError[];
  readonly retryAfterSeconds?: number;
  readonly expose: boolean;

  constructor(input: {
    status: number;
    code: DomainErrorCode;
    title: string;
    detail: string;
    errors?: FieldError[];
    retryAfterSeconds?: number;
    expose?: boolean;
  }) {
    super(input.detail);
    this.name = 'AppError';
    this.status = input.status;
    this.code = input.code;
    this.title = input.title;
    this.errors = input.errors;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.expose = input.expose ?? input.status < 500;
  }
}

export const badRequest = (detail: string, errors?: FieldError[]): AppError =>
  new AppError({ status: 400, code: 'VALIDATION_FAILED', title: 'Bad Request', detail, errors });

export const unauthorized = (detail = 'Authentication required'): AppError =>
  new AppError({ status: 401, code: 'UNAUTHORIZED', title: 'Unauthorized', detail });

export const forbidden = (detail = 'Insufficient permissions'): AppError =>
  new AppError({ status: 403, code: 'FORBIDDEN', title: 'Forbidden', detail });

export const notFound = (detail = 'Resource not found'): AppError =>
  new AppError({ status: 404, code: 'NOT_FOUND', title: 'Not Found', detail });

export const conflict = (code: DomainErrorCode, title: string, detail: string): AppError =>
  new AppError({ status: 409, code, title, detail });

export const soldOut = (detail = 'Ticket tier is sold out'): AppError =>
  conflict('SOLD_OUT', 'Sold Out', detail);

export const limitExceeded = (detail = 'Per-user ticket limit exceeded'): AppError =>
  conflict('LIMIT_EXCEEDED', 'Limit Exceeded', detail);

export const invalidStateTransition = (detail: string): AppError =>
  conflict('INVALID_STATE_TRANSITION', 'Invalid State Transition', detail);

export const idempotencyConflict = (detail: string): AppError =>
  new AppError({
    status: 422,
    code: 'IDEMPOTENCY_CONFLICT',
    title: 'Idempotency Conflict',
    detail,
  });

export const idempotencyInProgress = (detail: string): AppError =>
  new AppError({
    status: 409,
    code: 'IDEMPOTENCY_IN_PROGRESS',
    title: 'Idempotency In Progress',
    detail,
    retryAfterSeconds: 1,
  });

export const dependencyUnavailable = (detail: string): AppError =>
  new AppError({
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    title: 'Dependency Unavailable',
    detail,
    retryAfterSeconds: 5,
  });

export const rateLimited = (detail: string, retryAfterSeconds: number): AppError =>
  new AppError({
    status: 429,
    code: 'RATE_LIMITED',
    title: 'Too Many Requests',
    detail,
    retryAfterSeconds,
  });

export const internalError = (detail = 'Unexpected server error'): AppError =>
  new AppError({
    status: 500,
    code: 'INTERNAL_ERROR',
    title: 'Internal Server Error',
    detail,
    expose: false,
  });

export const toProblem = (
  error: AppError,
  instance: string,
  requestId?: string,
): ProblemDetails => {
  const problem: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}/${error.code.toLowerCase().replace(/_/g, '-')}`,
    title: error.title,
    status: error.status,
    detail: error.expose ? error.message : 'Unexpected server error',
    instance,
    code: error.code,
  };
  if (requestId) problem.requestId = requestId;
  if (error.errors && error.errors.length > 0) problem.errors = error.errors;
  if (error.retryAfterSeconds !== undefined) problem.retryAfterSeconds = error.retryAfterSeconds;
  return problem;
};
