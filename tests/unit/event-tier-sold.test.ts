import { describe, expect, it } from 'bun:test';
import type { Collections } from '../../src/infra/db/collections.ts';
import type { EventDoc, TicketTierDoc } from '../../src/infra/db/types.ts';
import type { CacheStore } from '../../src/infra/redis/cache.ts';
import { EventService } from '../../src/modules/events/service.ts';

const eventDoc = (overrides: Partial<EventDoc> = {}): EventDoc => ({
  _id: 'evt_1',
  name: 'Jazz Night',
  description: 'Live jazz',
  category: 'music',
  city: 'jakarta',
  venue: 'Hall A',
  startsAt: new Date('2026-03-01T10:00:00.000Z'),
  status: 'ON_SALE',
  searchText: 'jazz night live jazz',
  createdBy: 'usr_admin',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
  ...overrides,
});

const tierDoc = (overrides: Partial<TicketTierDoc> = {}): TicketTierDoc => ({
  _id: 'tier_1',
  eventId: 'evt_1',
  name: 'Regular',
  price: 150000,
  quota: 10,
  saleStartsAt: new Date('2026-02-01T00:00:00.000Z'),
  saleEndsAt: new Date('2026-02-28T00:00:00.000Z'),
  maxPerUser: 4,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildService = (input: {
  event: EventDoc;
  tiers: TicketTierDoc[];
  soldByTier: Record<string, number>;
}): EventService => {
  const collections = {
    events: {
      findOne: async () => input.event,
    },
    ticketTiers: {
      find: () => ({
        sort: () => ({ toArray: async () => input.tiers }),
      }),
    },
    tickets: {
      aggregate: () => ({
        toArray: async () =>
          Object.entries(input.soldByTier).map(([tierId, sold]) => ({ _id: tierId, sold })),
      }),
    },
  } as unknown as Collections;
  const cache = {
    getEventVersion: async () => '1',
    remember: async <T>(
      _key: string,
      _name: string,
      loader: () => Promise<T | null>,
    ): Promise<{ value: T | null; hit: boolean }> => ({ value: await loader(), hit: false }),
  } as unknown as CacheStore;
  const env = { CACHE_DETAIL_TTL_SECONDS: 60, CACHE_LIST_TTL_SECONDS: 30 } as never;
  return new EventService({ collections, cache, env });
};

describe('event detail tiers with sold/remaining', () => {
  it('reports sold and remaining per tier from ticket counts', async () => {
    const service = buildService({
      event: eventDoc(),
      tiers: [tierDoc({ _id: 'tier_1', quota: 10 }), tierDoc({ _id: 'tier_2', quota: 5 })],
      soldByTier: { tier_1: 1 },
    });
    const result = await service.getById('evt_1', { include: ['tiers'] });
    const tiers = result.body.data.tiers as Array<Record<string, unknown>>;
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toMatchObject({ id: 'tier_1', quota: 10, sold: 1, remaining: 9 });
    expect(tiers[1]).toMatchObject({ id: 'tier_2', quota: 5, sold: 0, remaining: 5 });
  });

  it('clamps remaining at zero when sold exceeds quota', async () => {
    const service = buildService({
      event: eventDoc(),
      tiers: [tierDoc({ _id: 'tier_1', quota: 3 })],
      soldByTier: { tier_1: 5 },
    });
    const result = await service.getById('evt_1', { include: ['tiers'] });
    const tiers = result.body.data.tiers as Array<Record<string, unknown>>;
    expect(tiers[0]).toMatchObject({ sold: 5, remaining: 0 });
  });

  it('omits tiers when include is not requested', async () => {
    const service = buildService({ event: eventDoc(), tiers: [tierDoc()], soldByTier: {} });
    const result = await service.getById('evt_1');
    expect(result.body.data.tiers).toBeUndefined();
  });
});
