import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
});

beforeEach(async () => {
  await resetDatabase(harness.container);
});

afterAll(async () => {
  await harness.stop();
});

describe('orders API', () => {
  it('creates an order and returns the full order view', async () => {
    const tier = await seedTier(harness.container, { quota: 10, price: 250_000 });
    const user = await seedUser(harness.container, 500);

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 2 },
      headers: { 'idempotency-key': 'orders-view-1' },
    });

    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toContain('/v1/orders/');
    const order = (created.body as { data: { order: Record<string, unknown> } }).data.order;
    expect(order.userId).toBe(user.userId);
    expect(order.tierId).toBe(tier.tierId);
    expect(order.quantity).toBe(2);
    expect(order.unitPrice).toBe(250_000);
    expect(order.total).toBe(500_000);
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(typeof order.expiresAt).toBe('string');
  }, 30_000);

  it('only lists orders owned by the caller with cursor pagination', async () => {
    const tier = await seedTier(harness.container, { quota: 50, maxPerUser: 10 });
    const owner = await seedUser(harness.container, 501);
    const other = await seedUser(harness.container, 502);

    for (let index = 0; index < 3; index += 1) {
      await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
        token: owner.accessToken,
        body: { tierId: tier.tierId, quantity: 1 },
        headers: { 'idempotency-key': `list-owner-${index}` },
      });
    }
    await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: other.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'list-other-0' },
    });

    const page1 = await jsonRequest(harness.baseUrl, 'GET', '/v1/orders?limit=2', {
      token: owner.accessToken,
    });
    expect(page1.status).toBe(200);
    const body1 = page1.body as {
      data: Array<{ id: string; userId: string }>;
      meta: { nextCursor: string | null; hasMore: boolean };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.data.every((order) => order.userId === owner.userId)).toBe(true);
    expect(body1.meta.hasMore).toBe(true);
    expect(body1.meta.nextCursor).toBeTruthy();

    const page2 = await jsonRequest(
      harness.baseUrl,
      'GET',
      `/v1/orders?limit=2&cursor=${body1.meta.nextCursor}`,
      { token: owner.accessToken },
    );
    const body2 = page2.body as {
      data: Array<{ id: string; userId: string }>;
      meta: { hasMore: boolean };
    };
    expect(body2.data).toHaveLength(1);
    expect(body2.meta.hasMore).toBe(false);
    const ids = new Set([...body1.data, ...body2.data].map((order) => order.id));
    expect(ids.size).toBe(3);
  }, 60_000);

  it('rejects a cursor that belongs to another user', async () => {
    const tier = await seedTier(harness.container, { quota: 20, maxPerUser: 10 });
    const owner = await seedUser(harness.container, 503);
    const attacker = await seedUser(harness.container, 504);

    for (let index = 0; index < 2; index += 1) {
      await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
        token: owner.accessToken,
        body: { tierId: tier.tierId, quantity: 1 },
        headers: { 'idempotency-key': `cursor-owner-${index}` },
      });
    }

    const page = await jsonRequest(harness.baseUrl, 'GET', '/v1/orders?limit=1', {
      token: owner.accessToken,
    });
    const cursor = (page.body as { meta: { nextCursor: string } }).meta.nextCursor;

    const stolen = await jsonRequest(
      harness.baseUrl,
      'GET',
      `/v1/orders?limit=1&cursor=${cursor}`,
      {
        token: attacker.accessToken,
      },
    );
    expect(stolen.status).toBe(400);
  }, 30_000);

  it('forbids reading or cancelling someone else order', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const owner = await seedUser(harness.container, 505);
    const attacker = await seedUser(harness.container, 506);

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: owner.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'ownership-key' },
    });
    const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;

    const read = await jsonRequest(harness.baseUrl, 'GET', `/v1/orders/${orderId}`, {
      token: attacker.accessToken,
    });
    expect(read.status).toBe(403);

    const cancel = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/cancel`, {
      token: attacker.accessToken,
      body: {},
    });
    expect(cancel.status).toBe(403);

    const stillMine = await jsonRequest(harness.baseUrl, 'GET', `/v1/orders/${orderId}`, {
      token: owner.accessToken,
    });
    expect(stillMine.status).toBe(200);
    expect((stillMine.body as { data: { order: { status: string } } }).data.order.status).toBe(
      'PENDING_PAYMENT',
    );
  }, 30_000);

  it('rejects orders before the sale window with 403 SALE_NOT_STARTED', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    await harness.container.collections.ticketTiers.updateOne(
      { _id: tier.tierId },
      { $set: { saleStartsAt: new Date(Date.now() + 3_600_000) } },
    );
    const user = await seedUser(harness.container, 507);

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1 },
      headers: { 'idempotency-key': 'sale-not-started' },
    });
    expect(created.status).toBe(403);
    expect((created.body as { detail: string }).detail).toContain('Sale has not started');
  }, 30_000);

  it('rejects an unknown tier with 404 and validates quantity bounds', async () => {
    const user = await seedUser(harness.container, 508);
    const missing = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: 'tier_missing', quantity: 1 },
      headers: { 'idempotency-key': 'missing-tier' },
    });
    expect(missing.status).toBe(404);

    const tier = await seedTier(harness.container, { quota: 10 });
    const zero = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 0 },
      headers: { 'idempotency-key': 'zero-quantity' },
    });
    expect(zero.status).toBe(400);
  }, 30_000);

  it('rejects unknown body fields because schemas are strict', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 509);
    const result = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
      token: user.accessToken,
      body: { tierId: tier.tierId, quantity: 1, $set: { status: 'PAID' } },
      headers: { 'idempotency-key': 'strict-body' },
    });
    expect(result.status).toBe(400);
  }, 30_000);

  it('supports admin PATCH with allowlisted $set and rejects unknown fields', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const adminToken = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });

    const patched = await jsonRequest(harness.baseUrl, 'PATCH', `/v1/events/${tier.eventId}`, {
      token: adminToken,
      body: { name: 'Renamed Event', city: 'Surabaya' },
    });
    expect(patched.status).toBe(200);

    const stored = await harness.container.collections.events.findOne({ _id: tier.eventId });
    expect(stored?.name).toBe('Renamed Event');
    expect(stored?.city).toBe('surabaya');

    const rejected = await jsonRequest(harness.baseUrl, 'PATCH', `/v1/events/${tier.eventId}`, {
      token: adminToken,
      body: { deletedAt: new Date().toISOString() },
    });
    expect(rejected.status).toBe(400);
  }, 30_000);

  it('soft deletes events and hides them from the list', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const adminToken = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });

    const deleted = await jsonRequest(harness.baseUrl, 'DELETE', `/v1/events/${tier.eventId}`, {
      token: adminToken,
    });
    expect(deleted.status).toBe(204);

    const stored = await harness.container.collections.events.findOne({ _id: tier.eventId });
    expect(stored?.deletedAt).toBeInstanceOf(Date);

    const detail = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}`);
    expect(detail.status).toBe(404);

    const list = await fetch(`${harness.baseUrl}/v1/events?limit=100`);
    const body = (await list.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((event) => event.id)).not.toContain(tier.eventId);
  }, 30_000);

  it('bulk creates tiers with bulkWrite and reports per-item ids', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const adminToken = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });

    const result = await jsonRequest(
      harness.baseUrl,
      'POST',
      `/v1/events/${tier.eventId}/tiers/bulk`,
      {
        token: adminToken,
        body: {
          tiers: [
            {
              name: 'VIP',
              price: 900_000,
              quota: 20,
              saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
              saleEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
              maxPerUser: 2,
            },
            {
              name: 'Festival',
              price: 400_000,
              quota: 40,
              saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
              saleEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        },
      },
    );

    expect(result.status).toBe(201);
    const body = result.body as { data: { inserted: number; ids: string[] } };
    expect(body.data.inserted).toBe(2);
    expect(body.data.ids).toHaveLength(2);

    const stored = await harness.container.collections.ticketTiers
      .find({ _id: { $in: body.data.ids } })
      .toArray();
    expect(stored).toHaveLength(2);
  }, 30_000);
});
