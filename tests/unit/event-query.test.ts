import { describe, expect, it } from 'bun:test';
import type { EventDoc } from '../../src/infra/db/types.ts';
import {
  assertSafeFilterKeys,
  buildEventFilter,
  buildEventSort,
  buildProjection,
  normalizeCacheQuery,
  pickFields,
  serializeEventWithPrice,
} from '../../src/modules/events/query.ts';
import { hashRequest, stableStringify } from '../../src/shared/hash.ts';
import { AppError } from '../../src/shared/problem.ts';

describe('event query safety', () => {
  it('rejects mongo operators and dotted paths', () => {
    for (const key of ['$where', '$gt', 'name.$ne', '__proto__', 'constructor', 'prototype']) {
      expect(() => assertSafeFilterKeys({ [key]: 1 })).toThrow(AppError);
    }
  });

  it('builds filters only from validated fields', () => {
    const filter = buildEventFilter({
      q: 'jazz',
      category: 'music',
      city: 'jakarta',
      status: 'ON_SALE',
      date_from: new Date('2026-01-01T00:00:00.000Z'),
      date_to: new Date('2026-02-01T00:00:00.000Z'),
      limit: 20,
    });
    expect(filter.deletedAt).toBeNull();
    expect(filter.$text).toEqual({ $search: 'jazz' });
    expect(filter.category).toBe('music');
    expect(filter.city).toBe('jakarta');
    expect(filter.startsAt).toEqual({
      $gte: new Date('2026-01-01T00:00:00.000Z'),
      $lte: new Date('2026-02-01T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(filter);
    expect(serialized).not.toContain('$where');
  });

  it('maps date to a mongo sort and enrichment sorts to no mongo sort', () => {
    expect(buildEventSort('date')).toEqual({ startsAt: 1, _id: 1 });
    expect(buildEventSort('ending')).toBeNull();
    expect(buildEventSort('price-asc')).toBeNull();
    expect(buildEventSort('price-desc')).toBeNull();
  });

  it('projects only allowlisted fields', () => {
    const projection = buildProjection(['name', 'city']);
    expect(projection).toEqual({ _id: 1, name: 1, city: 1 });
    const picked = pickFields({ id: 'evt_1', name: 'Jazz', city: 'jakarta', venue: 'Hall' }, [
      'name',
      'city',
    ]);
    expect(picked).toEqual({ id: 'evt_1', name: 'Jazz', city: 'jakarta' });
  });
});

describe('cache key normalization', () => {
  it('ignores query parameter order', () => {
    const left = normalizeCacheQuery({ city: 'jakarta', category: 'music', limit: 20 });
    const right = normalizeCacheQuery({ category: 'music', limit: 20, city: 'jakarta' });
    expect(hashRequest(left)).toBe(hashRequest(right));
  });

  it('normalizes multi-value field ordering', () => {
    const left = normalizeCacheQuery({ fields: ['name', 'city'], limit: 10 });
    const right = normalizeCacheQuery({ fields: ['city', 'name'], limit: 10 });
    expect(hashRequest(left)).toBe(hashRequest(right));
  });

  it('differentiates values that change the result set', () => {
    const base = normalizeCacheQuery({ limit: 20 });
    const filtered = normalizeCacheQuery({ limit: 20, city: 'bandung' });
    expect(hashRequest(base)).not.toBe(hashRequest(filtered));
  });

  it('stable stringify sorts object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe('event list price range', () => {
  const doc: EventDoc = {
    _id: 'evt_1',
    name: 'Jazz Night',
    description: 'An evening of jazz',
    category: 'music',
    city: 'jakarta',
    venue: 'Hall A',
    startsAt: new Date('2026-03-01T19:00:00.000Z'),
    status: 'ON_SALE',
    searchText: 'jazz night an evening of jazz',
    createdBy: 'usr_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
  };

  it('exposes null prices for events without tiers', () => {
    const serialized = serializeEventWithPrice(doc);
    expect(serialized.minPrice).toBeNull();
    expect(serialized.maxPrice).toBeNull();
  });

  it('exposes the tier price range when tiers exist', () => {
    const serialized = serializeEventWithPrice(doc, { minPrice: 150000, maxPrice: 500000 });
    expect(serialized.minPrice).toBe(150000);
    expect(serialized.maxPrice).toBe(500000);
  });

  it('keeps the base event fields intact', () => {
    const serialized = serializeEventWithPrice(doc, { minPrice: 100000, maxPrice: 100000 });
    expect(serialized.id).toBe('evt_1');
    expect(serialized.name).toBe('Jazz Night');
    expect(serialized.status).toBe('ON_SALE');
  });
});

describe('event list urgency', () => {
  const doc: EventDoc = {
    _id: 'evt_1',
    name: 'Jazz Night',
    description: 'An evening of jazz',
    category: 'music',
    city: 'jakarta',
    venue: 'Hall A',
    startsAt: new Date('2026-03-01T19:00:00.000Z'),
    status: 'ON_SALE',
    searchText: 'jazz night an evening of jazz',
    createdBy: 'usr_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
  };

  it('defaults to no sale window and zero stock for events without tiers', () => {
    const serialized = serializeEventWithPrice(doc);
    expect(serialized.saleEndsAt).toBeNull();
    expect(serialized.totalQuota).toBe(0);
    expect(serialized.totalSold).toBe(0);
    expect(serialized.remaining).toBe(0);
  });

  it('exposes the earliest sale end and stock totals when urgency is given', () => {
    const serialized = serializeEventWithPrice(
      doc,
      { minPrice: 150000, maxPrice: 500000 },
      {
        saleEndsAt: '2026-03-01T18:00:00.000Z',
        totalQuota: 350,
        totalSold: 12,
        remaining: 338,
      },
    );
    expect(serialized.saleEndsAt).toBe('2026-03-01T18:00:00.000Z');
    expect(serialized.totalQuota).toBe(350);
    expect(serialized.totalSold).toBe(12);
    expect(serialized.remaining).toBe(338);
    expect(serialized.minPrice).toBe(150000);
  });
});
