const problemSchema = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'code'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    requestId: { type: 'string' },
    code: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          message: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
} as const;

const envelope = (dataSchema: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  required: ['data', 'meta', 'links'],
  properties: {
    data: dataSchema,
    meta: {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
        nextCursor: { type: ['string', 'null'] },
        hasMore: { type: 'boolean' },
      },
    },
    links: {
      type: 'object',
      properties: {
        self: { type: 'string' },
        next: { type: ['string', 'null'] },
        prev: { type: ['string', 'null'] },
      },
    },
  },
});

const errorResponses = (codes: number[]): Record<string, unknown> =>
  Object.fromEntries(
    codes.map((code) => [
      String(code),
      {
        description: `RFC 7807 problem response (${code})`,
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    ]),
  );

export const buildOpenApiDocument = (): Record<string, unknown> => ({
  openapi: '3.0.3',
  info: {
    title: 'TixWar — Flash Sale Ticketing API',
    version: '1.0.0',
    description:
      'Backend-only flash sale ticketing API. Redis stock gate, MongoDB sharded cluster via mongos, outbox and BullMQ saga.',
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
    schemas: {
      Problem: problemSchema,
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'evt_01JABCDEF' },
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          city: { type: 'string' },
          venue: { type: 'string' },
          startsAt: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED'] },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          userId: { type: 'string' },
          eventId: { type: 'string' },
          tierId: { type: 'string' },
          quantity: { type: 'integer' },
          unitPrice: { type: 'integer', description: 'Integer rupiah' },
          total: { type: 'integer' },
          status: {
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
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      Ticket: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          code: { type: 'string' },
          issuedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/v1/auth/register': {
      post: {
        tags: ['auth'],
        summary: 'Register a user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'User created with tokens' },
          ...errorResponses([400, 409, 429]),
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['auth'],
        summary: 'Login with email and password',
        responses: {
          200: { description: 'Access and refresh tokens' },
          ...errorResponses([400, 401, 429]),
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        tags: ['auth'],
        summary: 'Rotate refresh token (reuse detection)',
        responses: { 200: { description: 'New token pair' }, ...errorResponses([401]) },
      },
    },
    '/v1/auth/logout': {
      post: {
        tags: ['auth'],
        summary: 'Revoke refresh token',
        responses: { 204: { description: 'Revoked' }, ...errorResponses([401]) },
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
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED'],
            },
          },
          { name: 'date_from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'date_to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'price_min', in: 'query', schema: { type: 'integer' } },
          { name: 'price_max', in: 'query', schema: { type: 'integer' } },
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string' },
            description: 'Allowlist: startsAt, name, createdAt, updatedAt; prefix with - for desc',
          },
          {
            name: 'fields',
            in: 'query',
            schema: { type: 'string' },
            description: 'Allowlist projection',
          },
          {
            name: 'include',
            in: 'query',
            schema: { type: 'string', enum: ['tiers'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'Opaque keyset cursor',
          },
        ],
        responses: {
          200: {
            description: 'Event list',
            content: { 'application/json': { schema: envelope({ type: 'array', items: {} }) } },
          },
          ...errorResponses([400]),
        },
      },
      post: {
        tags: ['events'],
        summary: 'Create event (admin)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        responses: { 201: { description: 'Created' }, ...errorResponses([400, 401, 403]) },
      },
    },
    '/v1/events/{id}': {
      get: {
        tags: ['events'],
        summary: 'Event detail with ETag/304 support',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['tiers'] } },
          { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Event detail' },
          304: { description: 'Not modified' },
          ...errorResponses([404]),
        },
      },
      patch: {
        tags: ['events'],
        summary: 'Partial update with server-side $set/$unset (admin)',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Updated' }, ...errorResponses([400, 401, 403, 404]) },
      },
      delete: {
        tags: ['events'],
        summary: 'Soft delete (admin)',
        security: [{ bearerAuth: [] }],
        responses: { 204: { description: 'Deleted' }, ...errorResponses([401, 403, 404]) },
      },
    },
    '/v1/events/{id}/tiers/bulk': {
      post: {
        tags: ['events'],
        summary: 'Bulk create tiers with bulkWrite (admin)',
        security: [{ bearerAuth: [] }],
        responses: { 201: { description: 'Created' }, ...errorResponses([400, 401, 403, 404]) },
      },
    },
    '/v1/events/{id}/stream': {
      get: {
        tags: ['events'],
        summary: 'SSE stock stream for an event',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'text/event-stream' } },
      },
    },
    '/v1/orders': {
      post: {
        tags: ['orders'],
        summary: 'Create order (requires Idempotency-Key)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 8 },
          },
        ],
        responses: {
          201: { description: 'Order created' },
          ...errorResponses([400, 401, 403, 409, 422, 429, 503]),
        },
      },
      get: {
        tags: ['orders'],
        summary: 'List own orders with cursor pagination',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Orders' }, ...errorResponses([400, 401]) },
      },
    },
    '/v1/orders/{id}': {
      get: {
        tags: ['orders'],
        summary: 'Order detail',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Order' }, ...errorResponses([401, 403, 404]) },
      },
    },
    '/v1/orders/{id}/pay': {
      post: {
        tags: ['orders'],
        summary: 'Request payment (200 paid, 202 queued)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 8 },
          },
        ],
        responses: {
          200: { description: 'Payment accepted synchronously' },
          202: { description: 'Payment queued for retry' },
          ...errorResponses([400, 401, 403, 409, 422, 429]),
        },
      },
    },
    '/v1/orders/{id}/cancel': {
      post: {
        tags: ['orders'],
        summary: 'Cancel order and release stock',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Cancelled' }, ...errorResponses([401, 403, 409]) },
      },
    },
    '/v1/orders/{id}/stream': {
      get: {
        tags: ['orders'],
        summary: 'SSE order status stream (owner only)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'text/event-stream' },
          ...errorResponses([401, 403, 404]),
        },
      },
    },
    '/v1/tickets': {
      get: {
        tags: ['tickets'],
        summary: 'List own tickets',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Tickets' }, ...errorResponses([401]) },
      },
    },
    '/v1/tickets/{id}': {
      get: {
        tags: ['tickets'],
        summary: 'Ticket detail with short-lived presigned QR URL',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Ticket' }, ...errorResponses([401, 404]) },
      },
    },
    '/v1/webhooks/endpoints': {
      post: {
        tags: ['webhooks'],
        summary: 'Register webhook endpoint (secret shown once)',
        security: [{ bearerAuth: [] }],
        responses: { 201: { description: 'Created' }, ...errorResponses([400, 401, 403]) },
      },
      get: {
        tags: ['webhooks'],
        summary: 'List own webhook endpoints without secrets',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Endpoints' }, ...errorResponses([401]) },
      },
    },
    '/v1/webhooks/endpoints/{id}': {
      delete: {
        tags: ['webhooks'],
        summary: 'Deactivate webhook endpoint',
        security: [{ bearerAuth: [] }],
        responses: { 204: { description: 'Deactivated' }, ...errorResponses([401]) },
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
        responses: { 200: { description: 'text/event-stream' }, ...errorResponses([401, 403]) },
      },
    },
    '/debug/load': {
      post: {
        tags: ['debug'],
        summary: 'Run built-in load generator (single|crowd|abuse)',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Summary' }, ...errorResponses([400, 401, 403]) },
      },
    },
    '/debug/chaos': {
      post: {
        tags: ['debug'],
        summary: 'Toggle dependency failure or latency',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Chaos state' }, ...errorResponses([400, 401, 403]) },
      },
    },
  },
});
