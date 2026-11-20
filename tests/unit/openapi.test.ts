import { describe, expect, it } from 'bun:test';
import { buildOpenApiDocument } from '../../src/modules/docs/openapi.ts';

interface OpenApiDocument {
  components: { schemas: Record<string, Record<string, unknown>> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
}

const document = buildOpenApiDocument() as unknown as OpenApiDocument;

const collectRefs = (node: unknown, refs: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return refs;
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, refs);
    return refs;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === 'string') refs.push(record.$ref);
  for (const value of Object.values(record)) collectRefs(value, refs);
  return refs;
};

const operation = (path: string, method: string): Record<string, unknown> => {
  const item = document.paths[path];
  if (!item) throw new Error(`missing path ${path}`);
  const op = item[method];
  if (!op) throw new Error(`missing ${method} ${path}`);
  return op;
};

const contentSchema = (container: unknown): Record<string, unknown> | undefined => {
  const content = (container as { content?: Record<string, { schema?: unknown }> } | undefined)
    ?.content;
  if (!content) return undefined;
  for (const entry of Object.values(content)) {
    if (entry.schema !== undefined) return entry.schema as Record<string, unknown>;
  }
  return undefined;
};

describe('openapi document', () => {
  it('resolves every $ref to a declared component schema', () => {
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs
      .map((ref) => ref.replace('#/components/schemas/', ''))
      .filter((name) => !(name in document.components.schemas));
    expect(missing).toEqual([]);
  });

  it('exposes the tier price range on event list items', () => {
    const schema = document.components.schemas.EventListItem as Record<string, unknown>;
    expect(schema, 'EventListItem').toBeDefined();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const field of ['minPrice', 'maxPrice']) {
      expect(properties[field], `EventListItem.${field}`).toEqual({
        type: 'integer',
        nullable: true,
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      });
    }
    expect((schema.required as string[]).sort()).toEqual(
      expect.arrayContaining(['minPrice', 'maxPrice']),
    );
    const op = operation('/v1/events', 'get');
    const responses = op.responses as Record<string, Record<string, unknown>>;
    const listSchema = contentSchema(responses['200']) as Record<string, unknown>;
    const items = (listSchema.properties as Record<string, Record<string, unknown>>).data
      .items as Record<string, unknown>;
    expect(items.$ref).toBe('#/components/schemas/EventListItem');
  });

  it('declares a request body for every mutating endpoint that accepts one', () => {
    const endpoints: Array<[string, string, string]> = [
      ['/v1/auth/register', 'post', 'RegisterRequest'],
      ['/v1/auth/login', 'post', 'LoginRequest'],
      ['/v1/auth/refresh', 'post', 'RefreshRequest'],
      ['/v1/auth/logout', 'post', 'RefreshRequest'],
      ['/v1/api-keys', 'post', 'CreateApiKeyRequest'],
      ['/v1/events', 'post', 'CreateEventRequest'],
      ['/v1/events/{id}', 'patch', 'PatchEventRequest'],
      ['/v1/events/{id}/tiers/bulk', 'post', 'BulkTiersRequest'],
      ['/v1/orders', 'post', 'CreateOrderRequest'],
      ['/v1/orders/{id}/pay', 'post', 'PayRequest'],
      ['/v1/orders/{id}/cancel', 'post', 'CancelOrderRequest'],
      ['/v1/webhooks/endpoints', 'post', 'CreateWebhookRequest'],
      ['/debug/load', 'post', 'DebugLoadRequest'],
      ['/debug/chaos', 'post', 'DebugChaosRequest'],
    ];

    for (const [path, method, schemaName] of endpoints) {
      const op = operation(path, method);
      const body = op.requestBody as Record<string, unknown> | undefined;
      expect(body, `${method.toUpperCase()} ${path} requestBody`).toBeDefined();
      const schema = contentSchema(body);
      expect(schema?.$ref, `${method.toUpperCase()} ${path} schema`).toBe(
        `#/components/schemas/${schemaName}`,
      );
    }
  });

  it('renders date-time fields instead of unrepresentable empty schemas', () => {
    for (const [name, fields] of [
      ['CreateEventRequest', ['startsAt']],
      ['PatchEventRequest', ['startsAt']],
      ['TierRequest', ['saleStartsAt', 'saleEndsAt']],
      ['BulkTiersRequest', []],
    ] as Array<[string, string[]]>) {
      const schema = document.components.schemas[name] as Record<string, unknown>;
      expect(schema, name).toBeDefined();
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      for (const field of fields) {
        expect(properties[field], `${name}.${field}`).toEqual({
          type: 'string',
          format: 'date-time',
        });
      }
    }

    const bulk = document.components.schemas.BulkTiersRequest.properties as Record<
      string,
      { items?: { properties?: Record<string, Record<string, unknown>> } }
    >;
    const tier = bulk.tiers.items?.properties ?? {};
    expect(tier.saleStartsAt).toEqual({ type: 'string', format: 'date-time' });
    expect(tier.saleEndsAt).toEqual({ type: 'string', format: 'date-time' });
  });

  it('keeps no empty schema inside request bodies', () => {
    const offenders: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const body = (op as { requestBody?: unknown }).requestBody;
        if (!body) continue;
        const walk = (node: unknown, where: string): void => {
          if (node === null || typeof node !== 'object') return;
          if (Array.isArray(node)) {
            for (const [index, entry] of node.entries()) walk(entry, `${where}[${index}]`);
            return;
          }
          const record = node as Record<string, unknown>;
          if (
            record.properties === undefined &&
            record.$ref === undefined &&
            record.type === undefined &&
            record.anyOf === undefined &&
            Object.keys(record).length === 0
          ) {
            offenders.push(where);
            return;
          }
          for (const [key, value] of Object.entries(record)) walk(value, `${where}.${key}`);
        };
        walk(body, `${method.toUpperCase()} ${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares the RFC 7807 problem shape', () => {
    const problem = document.components.schemas.Problem;
    expect(problem.required).toEqual(['type', 'title', 'status', 'detail', 'code']);
    const properties = problem.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['type', 'title', 'status', 'detail', 'code', 'errors']),
    );
  });

  it('documents rate limit headers on 429 responses', () => {
    const op = operation('/v1/orders', 'post');
    const responses = op.responses as Record<string, Record<string, unknown>>;
    const headers = responses['429'].headers as Record<string, unknown>;
    expect(Object.keys(headers).sort()).toEqual([
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ]);
  });

  it('wraps collection responses in the data/meta/links envelope', () => {
    const op = operation('/v1/orders', 'get');
    const responses = op.responses as Record<string, Record<string, unknown>>;
    const schema = contentSchema(responses['200']) as Record<string, unknown>;
    expect(schema.required).toEqual(['data', 'meta', 'links']);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.meta).toEqual({ $ref: '#/components/schemas/Meta' });
    expect(properties.links).toEqual({ $ref: '#/components/schemas/Links' });
  });

  it('documents SSE endpoints as text/event-stream', () => {
    for (const [path, method] of [
      ['/v1/events/{id}/stream', 'get'],
      ['/v1/orders/{id}/stream', 'get'],
      ['/debug/stream', 'get'],
    ] as Array<[string, string]>) {
      const op = operation(path, method);
      const responses = op.responses as Record<string, Record<string, unknown>>;
      const content = responses['200'].content as Record<string, unknown>;
      expect(Object.keys(content), `${method.toUpperCase()} ${path}`).toEqual([
        'text/event-stream',
      ]);
    }
  });

  it('requires Idempotency-Key on order creation and payment', () => {
    for (const [path, method] of [
      ['/v1/orders', 'post'],
      ['/v1/orders/{id}/pay', 'post'],
    ] as Array<[string, string]>) {
      const op = operation(path, method);
      const parameters = op.parameters as Array<Record<string, unknown>>;
      const idempotency = parameters.find((param) => param.name === 'Idempotency-Key');
      expect(idempotency, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(idempotency?.required).toBe(true);
    }
  });
});
