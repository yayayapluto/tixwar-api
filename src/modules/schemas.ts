import { z } from 'zod';

const objectIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export const idSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{1,64}$`), `must be a ${prefix}* id`);

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(128),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(10).max(4096),
  })
  .strict();

export const logoutSchema = refreshSchema;

export const forgotPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10).max(4096),
    password: z.string().min(10).max(128),
  })
  .strict();

export const createEventSchema = z
  .object({
    name: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).default(''),
    category: z.string().trim().min(2).max(60),
    city: z.string().trim().min(2).max(60),
    venue: z.string().trim().min(2).max(200),
    startsAt: z.coerce.date(),
    status: z.enum(['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED']).default('SCHEDULED'),
  })
  .strict();

export const patchEventSchema = z
  .object({
    name: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    category: z.string().trim().min(2).max(60).optional(),
    city: z.string().trim().min(2).max(60).optional(),
    venue: z.string().trim().min(2).max(200).optional(),
    startsAt: z.coerce.date().optional(),
    status: z.enum(['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const tierSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    price: z.number().int().min(0).max(1_000_000_000),
    quota: z.number().int().min(0).max(1_000_000),
    saleStartsAt: z.coerce.date(),
    saleEndsAt: z.coerce.date(),
    maxPerUser: z.number().int().min(1).max(100).default(4),
  })
  .strict()
  .refine((value) => value.saleEndsAt.getTime() > value.saleStartsAt.getTime(), {
    message: 'saleEndsAt must be after saleStartsAt',
    path: ['saleEndsAt'],
  });

export const bulkTiersSchema = z
  .object({
    tiers: z.array(tierSchema).min(1).max(20),
  })
  .strict();

export const createOrderSchema = z
  .object({
    tierId: idSchema('tier_'),
    quantity: z.number().int().min(1).max(100),
  })
  .strict();

export const payOrderSchema = z.object({}).strict();

export const cancelOrderSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .default({});

export const createWebhookSchema = z
  .object({
    url: z.string().url().max(2000),
  })
  .strict();

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const objectId = (value: string): boolean => objectIdPattern.test(value);

const ORDER_STATUS_VALUES = [
  'PENDING_PAYMENT',
  'PAYMENT_QUEUED',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;

const EVENT_STATUS_VALUES = ['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED'] as const;

const parseCsv = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? Array.from(new Set(parts)) : undefined;
};

const ALLOWED_QUERY_PARAMS = [
  'q',
  'category',
  'city',
  'status',
  'date_from',
  'date_to',
  'price_min',
  'price_max',
  'sort',
  'fields',
  'include',
  'page',
  'limit',
  'cursor',
] as const;

const SORTABLE_FIELDS = ['startsAt', 'name', 'createdAt', 'updatedAt'] as const;
const EVENT_FIELDS = [
  'id',
  'name',
  'description',
  'category',
  'city',
  'venue',
  'startsAt',
  'status',
  'createdAt',
  'updatedAt',
] as const;
const INCLUDE_OPTIONS = ['tiers'] as const;

const rejectUnknownQueryKeys = (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
  const allowed = new Set<string>(ALLOWED_QUERY_PARAMS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `unknown query parameter; allowed: ${ALLOWED_QUERY_PARAMS.join(', ')}`,
      });
    }
  }
};

const sortSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const result: Array<{ field: string; direction: 1 | -1 }> = [];
    for (const part of parts) {
      const [rawField, rawDirection] = part.startsWith('-')
        ? [part.slice(1), 'desc']
        : part.split(':');
      const field = (rawField ?? '').trim();
      if (!(SORTABLE_FIELDS as readonly string[]).includes(field)) {
        ctx.addIssue({
          code: 'custom',
          message: `sort field "${field}" is not allowed; allowed: ${SORTABLE_FIELDS.join(', ')}`,
        });
        return z.NEVER;
      }
      const direction = rawDirection === undefined || rawDirection === 'asc' ? 1 : -1;
      if (rawDirection !== undefined && rawDirection !== 'asc' && rawDirection !== 'desc') {
        ctx.addIssue({
          code: 'custom',
          message: `sort direction "${rawDirection}" is not allowed`,
        });
        return z.NEVER;
      }
      result.push({ field, direction });
    }
    return result;
  })
  .optional();

const fieldsSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    for (const part of parts) {
      if (!(EVENT_FIELDS as readonly string[]).includes(part)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${part}" is not allowed; allowed: ${EVENT_FIELDS.join(', ')}`,
        });
        return z.NEVER;
      }
    }
    return Array.from(new Set(parts));
  });

const includeSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    const parts = parseCsv(value) ?? [];
    for (const part of parts) {
      if (!(INCLUDE_OPTIONS as readonly string[]).includes(part)) {
        ctx.addIssue({
          code: 'custom',
          message: `include "${part}" is not allowed; allowed: ${INCLUDE_OPTIONS.join(', ')}`,
        });
        return z.NEVER;
      }
    }
    return Array.from(new Set(parts));
  });

export const eventListQuerySchema = z
  .object({
    q: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().min(1).max(200).optional(),
    ),
    category: z.string().trim().toLowerCase().max(60).optional(),
    city: z.string().trim().toLowerCase().max(60).optional(),
    status: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
        z.enum(EVENT_STATUS_VALUES),
      )
      .optional(),
    date_from: z.coerce.date().optional(),
    date_to: z.coerce.date().optional(),
    price_min: z.coerce.number().int().min(0).optional(),
    price_max: z.coerce.number().int().min(0).optional(),
    sort: sortSchema,
    fields: fieldsSchema,
    include: includeSchema,
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(4).max(2048).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.page !== undefined && value.cursor !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'cursor cannot be combined with page',
      });
    }
    if (value.date_from && value.date_to && value.date_from.getTime() > value.date_to.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['date_to'],
        message: 'date_to must be on or after date_from',
      });
    }
    if (
      value.price_min !== undefined &&
      value.price_max !== undefined &&
      value.price_min > value.price_max
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['price_max'],
        message: 'price_max must be greater than or equal to price_min',
      });
    }
  });

export const eventListQueryGuard = z
  .record(z.string(), z.unknown())
  .superRefine(rejectUnknownQueryKeys);

export const orderListQuerySchema = z
  .object({
    status: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
        z.enum(ORDER_STATUS_VALUES),
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(4).max(2048).optional(),
  })
  .strict();

export const ticketListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(4).max(2048).optional(),
  })
  .strict();

export const webhookListQuerySchema = z.object({}).strict();

export const debugLoadSchema = z
  .object({
    scenario: z.enum(['single', 'crowd', 'abuse']),
    eventId: idSchema('evt_').optional(),
    tierId: idSchema('tier_').optional(),
    userId: idSchema('usr_').optional(),
    concurrency: z.number().int().min(1).max(200).default(20),
    requests: z.number().int().min(1).max(5000).default(100),
    quantity: z.number().int().min(1).max(10).default(1),
  })
  .strict();

export const debugChaosSchema = z
  .object({
    target: z.enum(['gateway', 'worker', 'redis', 'mongo']),
    action: z.enum(['fail', 'latency', 'recover', 'failure-rate', 'slow']),
    value: z.number().min(0).max(60_000).optional(),
  })
  .strict();

export const debugSlowSchema = z.coerce.number().int().min(0).max(5000);

export const ALLOWED_EVENT_QUERY_KEYS = ALLOWED_QUERY_PARAMS;
export const EVENT_SORTABLE_FIELDS = SORTABLE_FIELDS;
export const EVENT_SELECTABLE_FIELDS = EVENT_FIELDS;

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type PatchEventInput = z.infer<typeof patchEventSchema>;
export type BulkTiersInput = z.infer<typeof bulkTiersSchema>;
export type EventListQueryInput = z.infer<typeof eventListQuerySchema>;
export type OrderListQueryInput = z.infer<typeof orderListQuerySchema>;
export type TicketListQueryInput = z.infer<typeof ticketListQuerySchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type DebugLoadInput = z.infer<typeof debugLoadSchema>;
export type DebugChaosInput = z.infer<typeof debugChaosSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
