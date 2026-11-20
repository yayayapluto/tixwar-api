import { z } from 'zod';

const dateTime = z.iso.datetime();

export const metaSchema = z
  .object({
    page: z.number().int().optional(),
    limit: z.number().int(),
    total: z.number().int().optional(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const linksSchema = z
  .object({
    self: z.string(),
    next: z.string().nullable(),
    prev: z.string().nullable(),
  })
  .strict();

export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, meta: metaSchema, links: linksSchema }).strict();

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.string(),
    instance: z.string().optional(),
    requestId: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            field: z.string().optional(),
            message: z.string(),
            value: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const userSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: z.enum(['user', 'admin']),
  })
  .strict();

export const authSessionSchema = z
  .object({
    user: userSchema,
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int(),
  })
  .strict();

export const refreshResultSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int(),
  })
  .strict();

export const eventStatusSchema = z.enum(['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED']);

export const eventSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    city: z.string(),
    venue: z.string(),
    startsAt: dateTime,
    status: eventStatusSchema,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export const tierSchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    name: z.string(),
    price: z.number().int(),
    quota: z.number().int(),
    saleStartsAt: dateTime,
    saleEndsAt: dateTime,
    maxPerUser: z.number().int(),
  })
  .strict();

export const eventDetailSchema = eventSchema
  .extend({ tiers: z.array(tierSchema).optional() })
  .strict();

export const eventListItemSchema = eventSchema
  .extend({
    minPrice: z.number().int().nullable(),
    maxPrice: z.number().int().nullable(),
  })
  .strict();

export const eventCreateResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: eventStatusSchema,
  })
  .strict();

export const eventPatchResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: eventStatusSchema,
    updatedAt: dateTime,
  })
  .strict();

export const bulkTiersResultSchema = z
  .object({
    inserted: z.number().int(),
    ids: z.array(z.string()),
  })
  .strict();

export const eventStatsSchema = z
  .object({
    eventId: z.string(),
    sold: z.number().int(),
    revenue: z.number().int(),
    updatedAt: dateTime,
  })
  .strict();

export const orderStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'PAYMENT_QUEUED',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
]);

export const orderSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    eventId: z.string(),
    tierId: z.string(),
    quantity: z.number().int(),
    unitPrice: z.number().int(),
    total: z.number().int(),
    status: orderStatusSchema,
    expiresAt: dateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
    paymentAttempts: z.number().int(),
  })
  .strict();

export const orderResultSchema = z.object({ order: orderSchema }).strict();

export const orderCancelResultSchema = z
  .object({
    order: orderSchema,
    reason: z.string().nullable(),
  })
  .strict();

export const paymentSchema = z
  .object({
    id: z.string(),
    orderId: z.string(),
    status: z.enum(['QUEUED', 'SUCCEEDED', 'FAILED']),
    attempt: z.number().int(),
  })
  .strict();

export const payResultSchema = z
  .object({
    status: z.enum(['ACCEPTED', 'QUEUED']),
    payment: paymentSchema,
    orderStatus: orderStatusSchema,
  })
  .strict();

export const ticketSchema = z
  .object({
    id: z.string(),
    orderId: z.string(),
    eventId: z.string(),
    tierId: z.string(),
    code: z.string(),
    issuedAt: dateTime,
  })
  .strict();

export const ticketDetailSchema = z
  .object({
    ticket: ticketSchema,
    qrUrl: z.string(),
    qrExpiresIn: z.number().int(),
  })
  .strict();

export const apiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    active: z.boolean(),
    createdAt: dateTime,
    revokedAt: dateTime.nullable(),
  })
  .strict();

export const apiKeyCreatedSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    apiKey: z.string(),
    keyShownOnce: z.literal(true),
  })
  .strict();

export const webhookEndpointSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    active: z.boolean(),
    createdAt: dateTime,
  })
  .strict();

export const webhookCreatedSchema = z
  .object({
    endpoint: webhookEndpointSchema,
    secret: z.string(),
    secretShownOnce: z.literal(true),
  })
  .strict();

export const chaosStateSchema = z
  .object({
    target: z.enum(['gateway', 'worker', 'redis', 'mongo']),
    action: z.enum(['fail', 'latency', 'recover', 'failure-rate', 'slow']),
    applied: z.boolean(),
    detail: z.record(z.string(), z.unknown()),
  })
  .strict();
