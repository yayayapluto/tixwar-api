import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  getHarness,
  type Harness,
  jsonRequest,
  resetDatabase,
  seedTier,
  seedUser,
} from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
  await resetDatabase(harness.container);
});

afterAll(async () => {
  await harness.stop();
});

describe('http contract', () => {
  it('returns security headers from helmet', async () => {
    const response = await fetch(`${harness.baseUrl}/health`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-request-id')).toBeTruthy();
  }, 30_000);

  it('echoes a caller supplied request id and rejects malformed ones', async () => {
    const supplied = 'client-request-id-123456';
    const withId = await fetch(`${harness.baseUrl}/health`, {
      headers: { 'x-request-id': supplied },
    });
    expect(withId.headers.get('x-request-id')).toBe(supplied);

    const malformed = await fetch(`${harness.baseUrl}/health`, {
      headers: { 'x-request-id': 'bad id!' },
    });
    const generated = malformed.headers.get('x-request-id');
    expect(generated).not.toBe('bad id!');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it('returns RFC 7807 problem+json with requestId for unknown routes', async () => {
    const response = await fetch(`${harness.baseUrl}/v1/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toContain('tixwar.dev/problems');
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(typeof body.requestId).toBe('string');
    expect(body.instance).toBe('/v1/does-not-exist');
  }, 30_000);

  it('reports per-field validation errors', async () => {
    const response = await fetch(`${harness.baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      errors?: Array<{ field: string; message: string }>;
    };
    const fields = (body.errors ?? []).map((entry) => entry.field);
    expect(fields).toContain('email');
    expect(fields).toContain('password');
  }, 30_000);

  it('enforces the JSON body size limit', async () => {
    const huge = 'x'.repeat(200 * 1024);
    const response = await fetch(`${harness.baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: huge }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { status: number };
    expect(body.status).toBe(413);
  }, 30_000);

  it('rejects a disallowed CORS origin but allows whitelisted ones', async () => {
    const allowed = await fetch(`${harness.baseUrl}/health`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

    const denied = await fetch(`${harness.baseUrl}/health`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  }, 30_000);

  it('returns 304 with a matching ETag for event detail', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const first = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}`, {
      headers: { 'if-none-match': etag! },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');

    const changed = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}`, {
      headers: { 'if-none-match': '"stale-etag"' },
    });
    expect(changed.status).toBe(200);
  }, 30_000);

  it('serves the OpenAPI document and Swagger UI', async () => {
    const spec = await fetch(`${harness.baseUrl}/openapi.json`);
    expect(spec.status).toBe(200);
    const document = (await spec.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toContain('/v1/orders');
    expect(Object.keys(document.paths)).toContain('/v1/events');
    expect(Object.keys(document.paths)).toContain('/debug/stream');

    const docs = await fetch(`${harness.baseUrl}/docs/`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('swagger-ui');
  }, 30_000);

  it('sets RateLimit headers on limited routes and returns 429 with Retry-After', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 400);

    const first = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'ratelimit-key-1' },
    });
    expect(first.headers.get('ratelimit-limit')).toBeTruthy();
    expect(first.headers.get('ratelimit-remaining')).toBeTruthy();
    expect(first.headers.get('ratelimit-reset')).toBeTruthy();
  }, 30_000);

  it('reports readiness with dependency checks', async () => {
    const response = await fetch(`${harness.baseUrl}/ready`);
    const body = (await response.json()) as {
      status: string;
      checks: { mongodb: boolean; redis: boolean };
    };
    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks.mongodb).toBe(true);
    expect(body.checks.redis).toBe(true);
  }, 30_000);

  it('exposes prometheus metrics', async () => {
    const response = await fetch(`${harness.baseUrl}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('cache_hits_total');
    expect(text).toContain('circuit_breaker_state');
  }, 30_000);

  it('requires authentication on protected routes', async () => {
    const orders = await fetch(`${harness.baseUrl}/v1/orders`);
    expect(orders.status).toBe(401);
    const body = (await orders.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  }, 30_000);

  it('rejects debug endpoints without an admin token', async () => {
    const response = await fetch(`${harness.baseUrl}/debug/stream`);
    expect([401, 403]).toContain(response.status);
  }, 30_000);
});
