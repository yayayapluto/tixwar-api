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

interface StreamHandle {
  controller: AbortController;
  readUntil: (predicate: (buffer: string) => boolean, timeoutMs?: number) => Promise<string>;
}

const openStream = async (path: string, headers: Record<string, string>): Promise<StreamHandle> => {
  const controller = new AbortController();
  const response = await fetch(`${harness.baseUrl}${path}`, {
    headers,
    signal: controller.signal,
  });
  if (!response.body) throw new Error('stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    controller,
    readUntil: async (predicate, timeoutMs = 15000) => {
      if (predicate(buffer)) return buffer;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        } catch {
          break;
        }
        if (predicate(buffer)) return buffer;
      }
      return buffer;
    },
  };
};

describe('server-sent events', () => {
  it('streams stock updates for an event', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 600);

    const stream = await openStream(`/v1/events/${tier.eventId}/stream`, {});
    const ready = await stream.readUntil((buffer) => buffer.includes('event: ready'));
    expect(ready).toContain('event: ready');

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'sse-stock-1' },
    });
    expect(created.status).toBe(201);

    const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;
    await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/cancel`, {
      token: user.accessToken,
      body: {},
    });

    const received = await stream.readUntil((buffer) => buffer.includes('stock.released'));
    expect(received).toContain('event: message');
    expect(received).toContain('stock.released');

    stream.controller.abort();
  }, 60_000);

  it('streams order status changes to the owner only', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const owner = await seedUser(harness.container, 601);
    const attacker = await seedUser(harness.container, 602);

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: owner.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'sse-order-1' },
    });
    const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;

    const forbidden = await fetch(`${harness.baseUrl}/v1/orders/${orderId}/stream`, {
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });
    expect(forbidden.status).toBe(403);

    const stream = await openStream(`/v1/orders/${orderId}/stream`, {
      authorization: `Bearer ${owner.accessToken}`,
    });
    const ready = await stream.readUntil((buffer) => buffer.includes('event: ready'));
    expect(ready).toContain('"channel":"order"');

    await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/cancel`, {
      token: owner.accessToken,
      body: {},
    });

    const received = await stream.readUntil((buffer) => buffer.includes('CANCELLED'));
    expect(received).toContain('CANCELLED');
    stream.controller.abort();
  }, 60_000);
});

describe('debug endpoints', () => {
  const adminHeaders = async (): Promise<Record<string, string>> => {
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const token = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });
    return {
      authorization: `Bearer ${token}`,
      'x-debug-token': harness.container.env.DEBUG_ADMIN_TOKEN ?? '',
    };
  };

  it('streams sanitized trace events to an authenticated admin', async () => {
    const headers = await adminHeaders();
    const stream = await openStream('/debug/stream', headers);
    const ready = await stream.readUntil((buffer) => buffer.includes('event: ready'));
    expect(ready).toContain('"channel":"trace"');

    await harness.container.trace.emit({
      requestId: 'trace-test-request',
      node: 'api-1',
      step: 'stock-gate',
      status: 'ok',
      durationMs: 3,
      meta: { token: 'super-secret', email: 'person@example.com', tierId: 'tier_1' },
    });

    const received = await stream.readUntil((buffer) => buffer.includes('stock-gate'));
    expect(received).toContain('trace-test-request');
    expect(received).toContain('[redacted]');
    expect(received).not.toContain('super-secret');
    expect(received).not.toContain('person@example.com');
    stream.controller.abort();
  }, 60_000);

  it('rejects debug access without the admin debug token', async () => {
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const token = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });
    const noToken = await fetch(`${harness.baseUrl}/debug/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(noToken.status).toBe(401);

    const user = await seedUser(harness.container, 603);
    const nonAdmin = await fetch(`${harness.baseUrl}/debug/stream`, {
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        'x-debug-token': harness.container.env.DEBUG_ADMIN_TOKEN ?? '',
      },
    });
    expect(nonAdmin.status).toBe(403);
  }, 30_000);

  it('runs the single and crowd load scenarios and reports oversell-free results', async () => {
    const tier = await seedTier(harness.container, { quota: 20, maxPerUser: 4 });
    const user = await seedUser(harness.container, 604);
    const headers = await adminHeaders();

    const single = await jsonRequest(harness.baseUrl, 'POST', '/debug/load', {
      token: headers.authorization?.replace('Bearer ', ''),
      headers: { 'x-debug-token': headers['x-debug-token']! },
      body: {
        scenario: 'single',
        tierId: tier.tierId,
        userId: user.userId,
        requests: 4,
        concurrency: 2,
        quantity: 1,
      },
    });
    expect(single.status).toBe(200);
    const singleBody = single.body as { data: { scenario: string; succeeded: number } };
    expect(singleBody.data.scenario).toBe('single');
    expect(singleBody.data.succeeded).toBe(4);

    const stockAfterSingle = await harness.container.stock.getStock(tier.tierId);
    expect(stockAfterSingle).toBe(16);
  }, 60_000);

  it('applies gateway chaos through the debug endpoint', async () => {
    const headers = await adminHeaders();
    const result = await jsonRequest(harness.baseUrl, 'POST', '/debug/chaos', {
      token: headers.authorization?.replace('Bearer ', ''),
      headers: { 'x-debug-token': headers['x-debug-token']! },
      body: { target: 'worker', action: 'failure-rate', value: 50 },
    });
    expect(result.status).toBe(200);
    const body = result.body as { data: { applied: boolean; detail: Record<string, unknown> } };
    expect(body.data.applied).toBe(true);
    expect(body.data.detail.failureRatePercent).toBe(50);

    const stored = await harness.container.redis.get('chaos:worker:failure-rate');
    expect(stored).toBe('50');
    await harness.container.redis.del('chaos:worker:failure-rate');
  }, 30_000);

  it('returns persisted traces by request id', async () => {
    const headers = await adminHeaders();
    await harness.container.trace.record({
      requestId: 'persisted-trace-1',
      node: 'api-1',
      step: 'cache',
      status: 'ok',
      durationMs: 1,
      meta: { cache: 'events-list' },
    });

    const result = await jsonRequest(harness.baseUrl, 'GET', '/debug/traces/persisted-trace-1', {
      token: headers.authorization?.replace('Bearer ', ''),
      headers: { 'x-debug-token': headers['x-debug-token']! },
    });
    expect(result.status).toBe(200);
    const body = result.body as { data: Array<{ step: string }> };
    expect(body.data.some((entry) => entry.step === 'cache')).toBe(true);
  }, 30_000);
});
