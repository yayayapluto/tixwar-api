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

const placeOrder = async (
  baseUrl: string,
  token: string,
  tierId: string,
  key: string,
  quantity = 1,
) =>
  jsonRequest(baseUrl, 'POST', '/v1/orders', {
    token,
    body: { tierId, quantity },
    headers: { 'idempotency-key': key },
  });

describe('flash sale concurrency', () => {
  it('500 parallel requests against 50 stock produce exactly 50 successes and zero oversell', async () => {
    const tier = await seedTier(harness.container, { quota: 50, maxPerUser: 4 });
    const users = await Promise.all(
      Array.from({ length: 500 }, (_, index) => seedUser(harness.container, index)),
    );

    const results = await Promise.all(
      users.map((user, index) =>
        placeOrder(harness.baseUrl, user.accessToken, tier.tierId, `war-key-${index}`),
      ),
    );

    const successes = results.filter((result) => result.status === 201);
    const soldOut = results.filter(
      (result) => result.status === 409 && (result.body as { code?: string }).code === 'SOLD_OUT',
    );
    const rateLimited = results.filter((result) => result.status === 429);
    const other = results.filter(
      (result) => result.status !== 201 && result.status !== 429 && result.status !== 409,
    );

    expect(other).toHaveLength(0);
    expect(rateLimited).toHaveLength(0);
    expect(successes).toHaveLength(50);
    expect(soldOut.length).toBe(450);

    const durableOrders = await harness.container.collections.orders
      .find({ tierId: tier.tierId })
      .toArray();
    const durableQuantity = durableOrders.reduce((total, order) => total + order.quantity, 0);
    expect(durableOrders).toHaveLength(50);
    expect(durableQuantity).toBe(50);

    const redisStock = await harness.container.stock.getStock(tier.tierId);
    expect(redisStock).toBe(0);

    const totalQuota = 50;
    expect(durableQuantity).toBeLessThanOrEqual(totalQuota);
    expect(redisStock).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('enforces maxPerUser for a single user hammering the same tier', async () => {
    const tier = await seedTier(harness.container, { quota: 100, maxPerUser: 4 });
    const user = await seedUser(harness.container, 900);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        placeOrder(harness.baseUrl, user.accessToken, tier.tierId, `single-user-${index}`, 1),
      ),
    );

    const successes = results.filter((result) => result.status === 201);
    const limited = results.filter(
      (result) =>
        result.status === 409 && (result.body as { code?: string }).code === 'LIMIT_EXCEEDED',
    );
    expect(successes).toHaveLength(4);
    expect(limited).toHaveLength(6);

    const durable = await harness.container.collections.orders
      .find({ tierId: tier.tierId })
      .toArray();
    expect(durable.reduce((total, order) => total + order.quantity, 0)).toBe(4);
    expect(await harness.container.stock.getStock(tier.tierId)).toBe(96);
  }, 60_000);

  it('releases stock exactly once when the same order is cancelled twice', async () => {
    const tier = await seedTier(harness.container, { quota: 10, maxPerUser: 4 });
    const user = await seedUser(harness.container, 950);

    const created = await placeOrder(
      harness.baseUrl,
      user.accessToken,
      tier.tierId,
      'cancel-key-1',
      2,
    );
    expect(created.status).toBe(201);
    const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;

    const first = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/cancel`, {
      token: user.accessToken,
      body: {},
    });
    const second = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/cancel`, {
      token: user.accessToken,
      body: {},
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await harness.container.stock.getStock(tier.tierId)).toBe(10);
  }, 60_000);

  it('restores stock when the order expires', async () => {
    const tier = await seedTier(harness.container, { quota: 5, maxPerUser: 4 });
    const user = await seedUser(harness.container, 970);
    const created = await placeOrder(
      harness.baseUrl,
      user.accessToken,
      tier.tierId,
      'expire-key-1',
      2,
    );
    expect(created.status).toBe(201);
    const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;

    await harness.container.collections.orders.updateOne(
      { _id: orderId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const expired = await harness.container.orders.expireDueOrders(10);
    expect(expired).toContain(orderId);

    const order = await harness.container.collections.orders.findOne({ _id: orderId });
    expect(order?.status).toBe('EXPIRED');
    expect(await harness.container.stock.getStock(tier.tierId)).toBe(5);

    const events = await harness.container.collections.outboxEvents
      .find({ aggregateId: orderId, type: 'order.expired' })
      .toArray();
    expect(events).toHaveLength(1);
  }, 60_000);
});
