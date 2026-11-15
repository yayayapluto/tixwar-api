import { z } from 'zod';

const boolEnv = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback)
    .transform((value) => value === 'true' || value === '1');

const durationToSeconds = (value: string): number | null => {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return amount * factor;
};

const seconds = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const parsed = durationToSeconds(value);
      if (parsed === null) {
        ctx.addIssue({ code: 'custom', message: 'must match <number><s|m|h|d>' });
        return z.NEVER;
      }
      return parsed;
    });

const bytes = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const match = /^(\d+)(b|kb|mb)$/i.exec(value.trim());
      if (!match) {
        ctx.addIssue({ code: 'custom', message: 'must match <number><b|kb|mb>' });
        return z.NEVER;
      }
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      return unit === 'b' ? amount : unit === 'kb' ? amount * 1024 : amount * 1024 * 1024;
    });

const PLACEHOLDER_PATTERN = /^(replace-|changeme|secret|placeholder|your-)/i;

const secretSchema = z.string().min(16, 'secret must be at least 16 characters');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('tixwar-api'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT: bytes('100kb'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default('tixwar'),
  MONGODB_READ_PREFERENCE: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .default('primary'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(50),
  MONGODB_MIN_POOL_SIZE: z.coerce.number().int().min(0).default(5),
  MONGODB_MAX_CONNECTING: z.coerce.number().int().positive().default(10),
  MONGODB_WAIT_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MONGODB_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  MONGODB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MONGODB_WRITE_CONCERN: z.enum(['majority', '1']).default('majority'),

  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: secretSchema,
  JWT_REFRESH_SECRET: secretSchema,
  JWT_ACCESS_TTL: seconds('15m'),
  JWT_REFRESH_TTL: seconds('7d'),
  JWT_ISSUER: z.string().default('tixwar'),

  RATE_LIMIT_ANON: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_GLOBAL: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_LOCKOUT_FAILURES: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_ORDER_USER: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_ORDER_IP: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PAY_USER: z.coerce.number().int().positive().default(5),

  ORDER_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  STOCK_PREWARM_MINUTES: z.coerce.number().int().nonnegative().default(5),
  STOCK_RECONCILE_SECONDS: z.coerce.number().int().positive().default(60),
  MAX_PAYMENT_ATTEMPTS: z.coerce.number().int().positive().default(3),

  CACHE_LIST_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  CACHE_DETAIL_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().positive().default(10),

  GATEWAY_URL: z.string().min(1),
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  BREAKER_ERROR_THRESHOLD_PERCENT: z.coerce.number().int().min(1).max(100).default(50),
  BREAKER_VOLUME_THRESHOLD: z.coerce.number().int().positive().default(10),
  BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  SMTP_URL: z.string().default('smtp://mailpit:1025'),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  MAIL_FROM: z.string().default('TixWar <no-reply@tixwar.local>'),

  MINIO_ENDPOINT: z.string().default('minio'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: boolEnv('false'),
  MINIO_ACCESS_KEY: z.string().default('tixwar'),
  MINIO_SECRET_KEY: z.string().default('tixwar-minio-secret'),
  MINIO_BUCKET: z.string().default('tixwar-tickets'),
  MINIO_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  DEBUG_ENABLED: boolEnv('false'),
  DEBUG_ADMIN_TOKEN: z.string().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('tixwar'),
  SENTRY_DSN: z.string().optional(),
  METRICS_PORT: z.coerce.number().int().positive().default(9464),
  TRACE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TRACE_CHANNEL: z.string().default('trace'),

  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WEBHOOK_ALLOW_HTTP: boolEnv('true'),
  WEBHOOK_ALLOW_PRIVATE_NETWORK: boolEnv('true'),

  QUEUE_PREFIX: z.string().default('tixwar'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WORKER_CONCURRENCY_ORDER: z.coerce.number().int().positive().default(10),
  WORKER_CONCURRENCY_PAYMENT: z.coerce.number().int().positive().default(10),
  WORKER_CONCURRENCY_NOTIFICATION: z.coerce.number().int().positive().default(20),
  WORKER_CONCURRENCY_WEBHOOK: z.coerce.number().int().positive().default(10),
  WORKER_CONCURRENCY_EXPIRY: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

const PRODUCTION_FORBIDDEN_DEFAULTS: Array<keyof Env> = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
];

export const parseEnv = (source: Record<string, string | undefined>): Env => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = parsed.data;

  if (env.DEBUG_ENABLED && !env.DEBUG_ADMIN_TOKEN) {
    throw new Error('DEBUG_ADMIN_TOKEN is required when DEBUG_ENABLED=true');
  }

  if (env.NODE_ENV === 'production') {
    for (const key of PRODUCTION_FORBIDDEN_DEFAULTS) {
      const value = env[key];
      if (typeof value === 'string' && PLACEHOLDER_PATTERN.test(value)) {
        throw new Error(`${key} must not use a placeholder value in production`);
      }
    }
  }

  if (env.MONGODB_MIN_POOL_SIZE > env.MONGODB_MAX_POOL_SIZE) {
    throw new Error('MONGODB_MIN_POOL_SIZE must not exceed MONGODB_MAX_POOL_SIZE');
  }

  return env;
};

let cached: Env | null = null;

export const getEnv = (): Env => {
  if (!cached) cached = parseEnv(process.env);
  return cached;
};

export const resetEnvCache = (): void => {
  cached = null;
};
