import { describe, expect, it } from 'bun:test';
import {
  assertSafeFilterKeys,
  buildEventFilter,
  buildEventSort,
  buildProjection,
  normalizeCacheQuery,
  pickFields,
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

  it('always appends _id as the sort tie-breaker', () => {
    expect(buildEventSort(undefined)).toEqual({ startsAt: 1, _id: 1 });
    expect(buildEventSort([{ field: 'name', direction: -1 }])).toEqual({ name: -1, _id: 1 });
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
