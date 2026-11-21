import { z } from 'zod';
import {
  bulkTiersSchema,
  cancelOrderSchema,
  createApiKeySchema,
  createEventSchema,
  createOrderSchema,
  createWebhookSchema,
  debugChaosSchema,
  debugLoadSchema,
  forgotPasswordSchema,
  loginSchema,
  patchEventSchema,
  payOrderSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  tierSchema,
} from '../schemas.ts';
import {
  apiKeyCreatedSchema,
  apiKeySchema,
  authSessionSchema,
  bulkTiersResultSchema,
  chaosStateOverviewSchema,
  chaosStateSchema,
  eventCreateResultSchema,
  eventDetailSchema,
  eventListItemSchema,
  eventPatchResultSchema,
  eventSchema,
  eventStatsSchema,
  linksSchema,
  messageResultSchema,
  metaSchema,
  orderCancelResultSchema,
  orderResultSchema,
  orderSchema,
  paymentSchema,
  payResultSchema,
  problemSchema,
  refreshResultSchema,
  ticketDetailSchema,
  ticketSchema,
  tierSchema as tierModelSchema,
  userSchema,
  webhookCreatedSchema,
  webhookEndpointSchema,
} from './models.ts';

type JsonSchema = Record<string, unknown>;

const DATE_FIELDS = new Set(['startsAt', 'saleStartsAt', 'saleEndsAt', 'date_from', 'date_to']);

const patchDates = (node: unknown): void => {
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const isEmptySchema =
        value !== null && typeof value === 'object' && Object.keys(value as object).length === 0;
      if (isEmptySchema && DATE_FIELDS.has(key)) {
        (properties as Record<string, unknown>)[key] = {
          type: 'string',
          format: 'date-time',
        };
        continue;
      }
      patchDates(value);
    }
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) patchDates(value);
    if (Array.isArray(value)) for (const entry of value) patchDates(entry);
  }
};

const stripDateTimePattern = (node: unknown): void => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) stripDateTimePattern(entry);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === 'string' && record.format === 'date-time' && 'pattern' in record) {
    delete record.pattern;
  }
  for (const value of Object.values(record)) stripDateTimePattern(value);
};

const toJson = (schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema => {
  const json = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
  }) as JsonSchema;
  patchDates(json);
  stripDateTimePattern(json);
  return json;
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

const envelopeOf = (dataSchema: JsonSchema): JsonSchema => ({
  type: 'object',
  required: ['data', 'meta', 'links'],
  properties: { data: dataSchema, meta: ref('Meta'), links: ref('Links') },
});

const jsonBody = (name: string, required = true): JsonSchema => ({
  required,
  content: { 'application/json': { schema: ref(name) } },
});

const jsonResponse = (description: string, schema: JsonSchema): JsonSchema => ({
  description,
  content: { 'application/json': { schema } },
});

const sseResponse = (description: string, events: string[]): JsonSchema => ({
  description: `${description}. Event names: ${events.join(', ')}. Each frame is \`event: <name>\`, \`id: <id>\`, \`data: <json>\`.`,
  content: { 'text/event-stream': { schema: { type: 'string' } } },
});

const rateLimitHeaders: JsonSchema = {
  'RateLimit-Limit': { schema: { type: 'integer' }, description: 'Requests allowed in window' },
  'RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests left in window' },
  'RateLimit-Reset': { schema: { type: 'integer' }, description: 'Seconds until window reset' },
  'Retry-After': { schema: { type: 'integer' }, description: 'Seconds before retry' },
};

const problemResponses = (codes: number[]): Record<string, unknown> =>
  Object.fromEntries(
    codes.map((code) => [
      String(code),
      {
        description: `RFC 7807 problem response (${code})`,
        headers: code === 429 ? rateLimitHeaders : undefined,
        content: { 'application/problem+json': { schema: ref('Problem') } },
      },
    ]),
  );

const idempotencyHeader: JsonSchema = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 8 },
  description: 'Client-generated key; same key + same payload replays the stored result',
};

const pathId: JsonSchema = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
};

const eventStatusEnum = ['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED'];

const requestComponents = {
  RegisterRequest: toJson(registerSchema, 'input'),
  LoginRequest: toJson(loginSchema, 'input'),
  RefreshRequest: toJson(refreshSchema, 'input'),
  ForgotPasswordRequest: toJson(forgotPasswordSchema, 'input'),
  ResetPasswordRequest: toJson(resetPasswordSchema, 'input'),
  CreateEventRequest: toJson(createEventSchema, 'input'),
  PatchEventRequest: toJson(patchEventSchema, 'input'),
  TierRequest: toJson(tierSchema, 'input'),
  BulkTiersRequest: toJson(bulkTiersSchema, 'input'),
  CreateOrderRequest: toJson(createOrderSchema, 'input'),
  PayRequest: toJson(payOrderSchema, 'input'),
  CancelOrderRequest: toJson(cancelOrderSchema, 'input'),
  CreateWebhookRequest: toJson(createWebhookSchema, 'input'),
  CreateApiKeyRequest: toJson(createApiKeySchema, 'input'),
  DebugLoadRequest: toJson(debugLoadSchema, 'input'),
  DebugChaosRequest: toJson(debugChaosSchema, 'input'),
};

const responseComponents = {
  Problem: toJson(problemSchema),
  Meta: toJson(metaSchema),
  Links: toJson(linksSchema),
  User: toJson(userSchema),
  AuthSession: toJson(authSessionSchema),
  RefreshResult: toJson(refreshResultSchema),
  MessageResult: toJson(messageResultSchema),
  Event: toJson(eventSchema),
  EventDetail: toJson(eventDetailSchema),
  EventListItem: toJson(eventListItemSchema),
  TicketTier: toJson(tierModelSchema),
  EventCreateResult: toJson(eventCreateResultSchema),
  EventPatchResult: toJson(eventPatchResultSchema),
  BulkTiersResult: toJson(bulkTiersResultSchema),
  EventStats: toJson(eventStatsSchema),
  Order: toJson(orderSchema),
  OrderResult: toJson(orderResultSchema),
  OrderCancelResult: toJson(orderCancelResultSchema),
  Payment: toJson(paymentSchema),
  PayResult: toJson(payResultSchema),
  Ticket: toJson(ticketSchema),
  TicketDetail: toJson(ticketDetailSchema),
  ApiKey: toJson(apiKeySchema),
  ApiKeyCreated: toJson(apiKeyCreatedSchema),
  WebhookEndpoint: toJson(webhookEndpointSchema),
  WebhookCreated: toJson(webhookCreatedSchema),
  ChaosState: toJson(chaosStateSchema),
  ChaosStateOverview: toJson(chaosStateOverviewSchema),
};

export const buildOpenApiDocument = (): Record<string, unknown> => ({
  openapi: '3.0.3',
  info: {
    title: 'TixWar — Flash Sale Ticketing API',
    version: '1.0.0',
    description:
      'Backend flash sale ticketing API. Redis stock gate, MongoDB sharded cluster via mongos, outbox and BullMQ saga. Schemas are generated from the Zod contracts in src/modules/schemas.ts and src/modules/docs/models.ts.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'auth' },
    { name: 'events' },
    { name: 'orders' },
    { name: 'tickets' },
    { name: 'webhooks' },
    { name: 'ops' },
    { name: 'debug' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    schemas: { ...requestComponents, ...responseComponents },
  },
  paths: {
    '/v1/auth/register': {
      post: {
        tags: ['auth'],
        summary: 'Register a user',
        requestBody: jsonBody('RegisterRequest'),
        responses: {
          201: jsonResponse('User created with tokens', envelopeOf(ref('AuthSession'))),
          ...problemResponses([400, 409, 429]),
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['auth'],
        summary: 'Login with email and password',
        requestBody: jsonBody('LoginRequest'),
        responses: {
          200: jsonResponse('Access and refresh tokens', envelopeOf(ref('AuthSession'))),
          ...problemResponses([400, 401, 429]),
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        tags: ['auth'],
        summary: 'Rotate refresh token (reuse detection)',
        requestBody: jsonBody('RefreshRequest'),
        responses: {
          200: jsonResponse('New token pair', envelopeOf(ref('RefreshResult'))),
          ...problemResponses([400, 401]),
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        tags: ['auth'],
        summary: 'Revoke refresh token',
        requestBody: jsonBody('RefreshRequest'),
        responses: { 204: { description: 'Revoked' }, ...problemResponses([400, 401]) },
      },
    },
    '/v1/auth/forgot-password': {
      post: {
        tags: ['auth'],
        summary:
          'Request a password reset link (generic response, never reveals account existence)',
        requestBody: jsonBody('ForgotPasswordRequest'),
        responses: {
          200: jsonResponse(
            'Generic confirmation; a link is emailed only if the account exists',
            envelopeOf(ref('MessageResult')),
          ),
          ...problemResponses([400, 429]),
        },
      },
    },
    '/v1/auth/reset-password': {
      post: {
        tags: ['auth'],
        summary: 'Reset password with a token from the emailed link (single use, expires)',
        requestBody: jsonBody('ResetPasswordRequest'),
        responses: {
          200: jsonResponse(
            'Password reset; all sessions revoked',
            envelopeOf(ref('MessageResult')),
          ),
          ...problemResponses([400, 401, 429]),
        },
      },
    },
    '/v1/api-keys': {
      post: {
        tags: ['auth'],
        summary: 'Create API key (key shown once, stored as hash)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('CreateApiKeyRequest'),
        responses: {
          201: jsonResponse(
            'API key created; apiKey is returned once',
            envelopeOf(ref('ApiKeyCreated')),
          ),
          ...problemResponses([400, 401]),
        },
      },
      get: {
        tags: ['auth'],
        summary: 'List own API keys (no raw key)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: jsonResponse('API keys', envelopeOf({ type: 'array', items: ref('ApiKey') })),
          ...problemResponses([401]),
        },
      },
    },
    '/v1/api-keys/{id}': {
      delete: {
        tags: ['auth'],
        summary: 'Revoke API key',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        responses: { 204: { description: 'Revoked' }, ...problemResponses([401, 403, 404]) },
      },
    },
    '/v1/events': {
      get: {
        tags: ['events'],
        summary: 'List events with filters, search, sort, fields, include and pagination',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search' },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'city', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: eventStatusEnum } },
          { name: 'date_from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'date_to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'price_min', in: 'query', schema: { type: 'integer' } },
          { name: 'price_max', in: 'query', schema: { type: 'integer' } },
          {
            name: 'sort',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['ending', 'date', 'price-asc', 'price-desc'],
              default: 'ending',
            },
            description:
              'ending: saleEndsAt ascending, nulls last, tiebreak startsAt; date: startsAt ascending; price-asc: minPrice ascending, nulls last; price-desc: minPrice descending, nulls last',
          },
          {
            name: 'fields',
            in: 'query',
            schema: { type: 'string' },
            description: 'Allowlist projection',
          },
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['tiers'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'Opaque keyset cursor; cannot be combined with page',
          },
        ],
        responses: {
          200: jsonResponse(
            'Event list',
            envelopeOf({ type: 'array', items: ref('EventListItem') }),
          ),
          ...problemResponses([400, 429]),
        },
      },
      post: {
        tags: ['events'],
        summary: 'Create event (admin)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        requestBody: jsonBody('CreateEventRequest'),
        responses: {
          201: jsonResponse('Created', envelopeOf(ref('EventCreateResult'))),
          ...problemResponses([400, 401, 403]),
        },
      },
    },
    '/v1/events/{id}': {
      get: {
        tags: ['events'],
        summary: 'Event detail with ETag/304 support',
        parameters: [
          pathId,
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['tiers'] } },
          { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            ...jsonResponse('Event detail', envelopeOf(ref('EventDetail'))),
            headers: { ETag: { schema: { type: 'string' } } },
          },
          304: { description: 'Not modified' },
          ...problemResponses([404]),
        },
      },
      patch: {
        tags: ['events'],
        summary: 'Partial update with server-side $set/$unset (admin)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('PatchEventRequest'),
        responses: {
          200: jsonResponse('Updated', envelopeOf(ref('EventPatchResult'))),
          ...problemResponses([400, 401, 403, 404]),
        },
      },
      delete: {
        tags: ['events'],
        summary: 'Soft delete (admin)',
        security: [{ bearerAuth: [] }],
        responses: { 204: { description: 'Deleted' }, ...problemResponses([401, 403, 404]) },
      },
    },
    '/v1/events/{id}/tiers/bulk': {
      post: {
        tags: ['events'],
        summary: 'Bulk create tiers with bulkWrite (admin)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('BulkTiersRequest'),
        responses: {
          201: jsonResponse('Created', envelopeOf(ref('BulkTiersResult'))),
          ...problemResponses([400, 401, 403, 404]),
        },
      },
    },
    '/v1/events/{id}/stream': {
      get: {
        tags: ['events'],
        summary: 'SSE stock stream for an event',
        parameters: [pathId],
        responses: {
          200: sseResponse('Server-sent stock updates', ['ready', 'message', 'heartbeat']),
          ...problemResponses([404, 503]),
        },
      },
    },
    '/v1/events/{id}/stats': {
      get: {
        tags: ['events'],
        summary: 'Read model stats: sold and revenue for an event',
        parameters: [pathId],
        responses: {
          200: jsonResponse('Event stats', envelopeOf(ref('EventStats'))),
          ...problemResponses([404]),
        },
      },
    },
    '/v1/orders': {
      post: {
        tags: ['orders'],
        summary: 'Create order (requires Idempotency-Key)',
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: jsonBody('CreateOrderRequest'),
        responses: {
          201: jsonResponse('Order created', envelopeOf(ref('OrderResult'))),
          ...problemResponses([400, 401, 403, 409, 422, 429, 503]),
        },
      },
      get: {
        tags: ['orders'],
        summary: 'List own orders with cursor pagination',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: [
                'PENDING_PAYMENT',
                'PAYMENT_QUEUED',
                'PAID',
                'CONFIRMED',
                'PAYMENT_FAILED',
                'EXPIRED',
                'CANCELLED',
              ],
            },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: jsonResponse('Orders', envelopeOf({ type: 'array', items: ref('Order') })),
          ...problemResponses([400, 401]),
        },
      },
    },
    '/v1/orders/{id}': {
      get: {
        tags: ['orders'],
        summary: 'Order detail',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        responses: {
          200: jsonResponse('Order', envelopeOf(ref('OrderResult'))),
          ...problemResponses([401, 403, 404]),
        },
      },
    },
    '/v1/orders/{id}/pay': {
      post: {
        tags: ['orders'],
        summary: 'Request payment (200 paid, 202 queued)',
        security: [{ bearerAuth: [] }],
        parameters: [pathId, idempotencyHeader],
        requestBody: jsonBody('PayRequest'),
        responses: {
          200: jsonResponse('Payment accepted synchronously', envelopeOf(ref('PayResult'))),
          202: jsonResponse('Payment queued for retry', envelopeOf(ref('PayResult'))),
          ...problemResponses([400, 401, 403, 409, 422, 429]),
        },
      },
    },
    '/v1/orders/{id}/cancel': {
      post: {
        tags: ['orders'],
        summary: 'Cancel order and release stock',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        requestBody: jsonBody('CancelOrderRequest', false),
        responses: {
          200: jsonResponse('Cancelled', envelopeOf(ref('OrderCancelResult'))),
          ...problemResponses([401, 403, 409]),
        },
      },
    },
    '/v1/orders/{id}/stream': {
      get: {
        tags: ['orders'],
        summary: 'SSE order status stream (owner only)',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        responses: {
          200: sseResponse('Server-sent order status updates', ['ready', 'message', 'heartbeat']),
          ...problemResponses([401, 403, 404]),
        },
      },
    },
    '/v1/tickets': {
      get: {
        tags: ['tickets'],
        summary: 'List own tickets',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: jsonResponse('Tickets', envelopeOf({ type: 'array', items: ref('Ticket') })),
          ...problemResponses([401]),
        },
      },
    },
    '/v1/tickets/{id}': {
      get: {
        tags: ['tickets'],
        summary: 'Ticket detail with short-lived presigned QR URL',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        responses: {
          200: jsonResponse('Ticket', envelopeOf(ref('TicketDetail'))),
          ...problemResponses([401, 404]),
        },
      },
    },
    '/v1/webhooks/endpoints': {
      post: {
        tags: ['webhooks'],
        summary: 'Register webhook endpoint (secret shown once)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('CreateWebhookRequest'),
        responses: {
          201: jsonResponse('Created; secret is returned once', envelopeOf(ref('WebhookCreated'))),
          ...problemResponses([400, 401, 403]),
        },
      },
      get: {
        tags: ['webhooks'],
        summary: 'List own webhook endpoints without secrets',
        security: [{ bearerAuth: [] }],
        responses: {
          200: jsonResponse(
            'Endpoints',
            envelopeOf({ type: 'array', items: ref('WebhookEndpoint') }),
          ),
          ...problemResponses([401]),
        },
      },
    },
    '/v1/webhooks/endpoints/{id}': {
      delete: {
        tags: ['webhooks'],
        summary: 'Deactivate webhook endpoint',
        security: [{ bearerAuth: [] }],
        parameters: [pathId],
        responses: { 204: { description: 'Deactivated' }, ...problemResponses([401]) },
      },
    },
    '/health': {
      get: { tags: ['ops'], summary: 'Liveness probe', responses: { 200: { description: 'ok' } } },
    },
    '/ready': {
      get: {
        tags: ['ops'],
        summary: 'Readiness probe (mongos, redis, storage, queues)',
        responses: { 200: { description: 'ready' }, 503: { description: 'degraded' } },
      },
    },
    '/metrics': {
      get: {
        tags: ['ops'],
        summary: 'Prometheus metrics',
        responses: { 200: { description: 'text' } },
      },
    },
    '/debug/stream': {
      get: {
        tags: ['debug'],
        summary: 'SSE trace stream (admin + DEBUG_ENABLED)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: sseResponse('Server-sent trace events', ['ready', 'message', 'heartbeat']),
          ...problemResponses([401, 403]),
        },
      },
    },
    '/debug/load': {
      post: {
        tags: ['debug'],
        summary: 'Run built-in load generator (single|crowd|abuse)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('DebugLoadRequest'),
        responses: { 200: { description: 'Summary' }, ...problemResponses([400, 401, 403]) },
      },
    },
    '/debug/chaos': {
      get: {
        tags: ['debug'],
        summary: 'Read current chaos state per target (admin + DEBUG_ENABLED)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: jsonResponse('Chaos state overview', envelopeOf(ref('ChaosStateOverview'))),
          ...problemResponses([401, 403]),
        },
      },
      post: {
        tags: ['debug'],
        summary: 'Inject dependency failure or latency (auto-recovers)',
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody('DebugChaosRequest'),
        responses: {
          200: jsonResponse('Chaos state', envelopeOf(ref('ChaosState'))),
          ...problemResponses([400, 401, 403]),
        },
      },
    },
  },
});
