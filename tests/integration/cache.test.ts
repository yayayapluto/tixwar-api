import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  getHarness,
  type Harness,
  jsonRequest,
  resetDatabase,
  seedTier,
} from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
});

beforeEach(async () => {
  await resetDatabase(harness.container);
  await harness.container.cache.invalidateEvents();
});

afterAll(async () => {
  await harness.stop();
});

describe('event caching', () => {
  it('serves the first list request as a miss and the second as a hit', async () => {
    await seedTier(harness.container, { quota: 5 });

    const first = await fetch(`${harness.baseUrl}/v1/events?limit=5`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache')).toBe('MISS');

    const second = await fetch(`${harness.baseUrl}/v1/events?limit=5`);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-cache')).toBe('HIT');

    const metrics = await (await fetch(`${harness.baseUrl}/metrics`)).text();
    expect(metrics).toContain('cache_hits_total{cache="events-list"}');
    expect(metrics).toContain('cache_misses_total{cache="events-list"}');
  }, 30_000);

  it('invalidates the list cache when an admin creates an event', async () => {
    const admin = await harness.container.collections.users.findOne({ role: 'admin' });
    const adminToken = await harness.container.tokens.signAccessToken({
      userId: admin?._id ?? 'usr_test_admin',
      role: 'admin',
    });

    const before = await fetch(`${harness.baseUrl}/v1/events?limit=5`);
    expect(before.headers.get('x-cache')).toBe('MISS');
    const warm = await fetch(`${harness.baseUrl}/v1/events?limit=5`);
    expect(warm.headers.get('x-cache')).toBe('HIT');

    const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/events', {
      token: adminToken,
      body: {
        name: 'Cache Invalidation Event',
        category: 'music',
        city: 'bandung',
        venue: 'Hall',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        status: 'ON_SALE',
      },
    });
    expect(created.status).toBe(201);

    const after = await fetch(`${harness.baseUrl}/v1/events?limit=5`);
    expect(after.headers.get('x-cache')).toBe('MISS');
  }, 30_000);

  it('produces a stable cache key regardless of parameter order', async () => {
    await seedTier(harness.container, { quota: 5 });
    const first = await fetch(`${harness.baseUrl}/v1/events?city=jakarta&limit=5`);
    expect(first.headers.get('x-cache')).toBe('MISS');
    const second = await fetch(`${harness.baseUrl}/v1/events?limit=5&city=jakarta`);
    expect(second.headers.get('x-cache')).toBe('HIT');
  }, 30_000);

  it('serves stale content while the cache lock is held by another request', async () => {
    await seedTier(harness.container, { quota: 5 });
    const warm = await fetch(`${harness.baseUrl}/v1/events?limit=3`);
    expect(warm.status).toBe(200);

    const key = (await harness.container.redis.keys('events:list:*')).at(0);
    expect(key).toBeTruthy();
    await harness.container.redis.del(key!);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${harness.baseUrl}/v1/events?limit=3`)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const payloads = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(payloads.map((payload) => JSON.stringify(payload))).size).toBe(1);
  }, 30_000);

  it('caches event detail and returns 304 for matching ETags', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const first = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}?include=tiers`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const second = await fetch(`${harness.baseUrl}/v1/events/${tier.eventId}?include=tiers`, {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);

    const metrics = await (await fetch(`${harness.baseUrl}/metrics`)).text();
    expect(metrics).toContain('cache_hits_total{cache="event-detail"}');
  }, 30_000);
});
