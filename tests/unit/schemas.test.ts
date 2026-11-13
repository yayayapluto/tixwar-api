import { describe, expect, it } from 'bun:test';
import { eventListQueryGuard, eventListQuerySchema } from '../../src/modules/schemas.ts';

const parse = (query: Record<string, unknown>) => {
  eventListQueryGuard.parse(query);
  return eventListQuerySchema.parse(query);
};

describe('event list query schema', () => {
  it('coerces numbers, lowercases enums and dedupes lists', () => {
    const query = parse({
      limit: '50',
      page: '2',
      status: 'on_sale',
      city: '  JAKARTA ',
      fields: 'name,city,name',
      include: 'tiers',
    });
    expect(query.limit).toBe(50);
    expect(query.page).toBe(2);
    expect(query.status).toBe('ON_SALE');
    expect(query.city).toBe('jakarta');
    expect(query.fields).toEqual(['name', 'city']);
    expect(query.include).toEqual(['tiers']);
  });

  it('clamps the default limit and enforces the maximum', () => {
    expect(parse({}).limit).toBe(20);
    expect(() => parse({ limit: '101' })).toThrow();
  });

  it('rejects unknown query parameters with the allowlist in the message', () => {
    expect(() => parse({ unknown_param: '1' })).toThrow(/allowed: q, category, city/);
  });

  it('rejects mongo operator style parameters', () => {
    expect(() => parse({ $where: 'this.a == 1' })).toThrow(/unknown query parameter/);
    expect(() => parse({ 'name.$ne': 'x' })).toThrow(/unknown query parameter/);
  });

  it('rejects sort and fields outside the allowlist', () => {
    expect(() => parse({ sort: 'password' })).toThrow(/not allowed/);
    expect(() => parse({ fields: 'passwordHash' })).toThrow(/not allowed/);
    expect(() => parse({ sort: 'startsAt:sideways' })).toThrow(/direction/);
  });

  it('accepts descending sort with the -prefix and explicit direction', () => {
    expect(parse({ sort: '-startsAt' }).sort).toEqual([{ field: 'startsAt', direction: -1 }]);
    expect(parse({ sort: 'name:asc' }).sort).toEqual([{ field: 'name', direction: 1 }]);
  });

  it('rejects cursor combined with page', () => {
    expect(() => parse({ cursor: 'abcd', page: '2' })).toThrow(/cannot be combined/);
  });

  it('rejects inverted date and price ranges', () => {
    expect(() => parse({ date_from: '2026-02-01', date_to: '2026-01-01' })).toThrow(
      /date_to must be on or after/,
    );
    expect(() => parse({ price_min: '500', price_max: '100' })).toThrow(/price_max/);
  });

  it('names the offending field in validation errors', () => {
    try {
      parse({ limit: 'abc' });
      throw new Error('expected failure');
    } catch (error) {
      const message = String(error);
      expect(message).toContain('limit');
    }
  });
});
