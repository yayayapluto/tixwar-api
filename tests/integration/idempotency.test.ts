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

describe('idempotency keys', () => {
  it('replays the stored response for a repeated key and payload', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 100);
    const body = { tierId: tier.tierId, quantity: 1 };
    const headers = { 'idempotency-key': 'repeat-key-0001' };

    const first = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body,
      headers,
    });
    const second = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body,
      headers,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = (first.body as { data: { order: { id: string } } }).data.order.id;
    const secondId = (second.body as { data: { order: { id: string } } }).data.order.id;
    expect(secondId).toBe(firstId);

    const orders = await harness.container.collections.orders
      .find({ tierId: tier.tierId })
      .toArray();
    expect(orders).toHaveLength(1);
    expect(await harness.container.stock.getStock(tier.tierId)).toBe(9);
  }, 30_000);

  it('creates exactly one order for 10 parallel requests sharing one key', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 101);
    const body = { tierId: tier.tierId, quantity: 1 };
    const headers = { 'idempotency-key': 'parallel-key-0002' };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
          token: user.accessToken,
          body,
          headers,
        }),
      ),
    );

    const created = results.filter((result) => result.status === 201);
    const inProgress = results.filter((result) => result.status === 409);
    expect(created.length + inProgress.length).toBe(10);
    expect(created.length).toBeGreaterThanOrEqual(1);

    const ids = new Set(
      created.map((result) => (result.body as { data: { order: { id: string } } }).data.order.id),
    );
    expect(ids.size).toBe(1);

    const orders = await harness.container.collections.orders
      .find({ tierId: tier.tierId })
      .toArray();
    expect(orders).toHaveLength(1);
    expect(await harness.container.stock.getStock(tier.tierId)).toBe(9);
  }, 30_000);

  it('rejects the same key with a different payload using 422 IDEMPOTENCY_CONFLICT', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 102);
    const headers = { 'idempotency-key': 'conflict-key-0003' };

    const first = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers,
    });
    const second = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 2 },
      headers,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect((second.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  }, 30_000);

  it('scopes keys per owner so another user can reuse the same string', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const ownerA = await seedUser(harness.container, 103);
    const ownerB = await seedUser(harness.container, 104);
    const headers = { 'idempotency-key': 'shared-string-key' };
    const body = { tierId: tier.tierId, quantity: 1 };

    const a = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: ownerA.accessToken,
      body,
      headers,
    });
    const b = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: ownerB.accessToken,
      body,
      headers,
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = (a.body as { data: { order: { id: string } } }).data.order.id;
    const idB = (b.body as { data: { order: { id: string } } }).data.order.id;
    expect(idA).not.toBe(idB);
  }, 30_000);

  it('requires the Idempotency-Key header on POST /orders', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 105);
    const result = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
    });
    expect(result.status).toBe(400);
    expect((result.body as { detail: string }).detail).toContain('Idempotency-Key');
  }, 30_000);

  it('releases the idempotency claim when the handler fails so the key can be retried', async () => {
    const user = await seedUser(harness.container, 106);
    const headers = { 'idempotency-key': 'retry-after-failure' };
    const failed = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: 'tier_does_not_exist', quantity: 1 },
      headers,
    });
    expect(failed.status).toBe(404);

    const tier = await seedTier(harness.container, { quota: 5 });
    const retried = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers,
    });
    expect(retried.status).toBe(201);
  }, 30_000);
});
