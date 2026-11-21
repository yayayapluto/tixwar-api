import { describe, expect, it } from 'bun:test';
import {
  buildEventSort,
  compareEventSortKeys,
  type EventSortKeys,
  eventSortCursorScope,
  eventSortKeysFromCursor,
  eventSortKeysToCursor,
  parseEventSortMode,
} from '../../src/modules/events/query.ts';
import { AppError } from '../../src/shared/problem.ts';

const keys = (overrides: Partial<EventSortKeys> = {}): EventSortKeys => ({
  id: 'evt_1',
  startsAt: new Date('2026-03-01T19:00:00.000Z'),
  saleEndsAt: new Date('2026-02-20T18:00:00.000Z'),
  minPrice: 150000,
  ...overrides,
});

const sortedIds = (mode: Parameters<typeof compareEventSortKeys>[0], rows: EventSortKeys[]) =>
  [...rows].sort((left, right) => compareEventSortKeys(mode, left, right)).map((row) => row.id);

describe('event sort mode parsing', () => {
  it('defaults to ending when absent', () => {
    expect(parseEventSortMode(undefined)).toBe('ending');
  });

  it('accepts each documented mode', () => {
    for (const mode of ['ending', 'date', 'price-asc', 'price-desc'] as const) {
      expect(parseEventSortMode(mode)).toBe(mode);
    }
  });

  it('rejects anything outside the enum with a 400', () => {
    for (const value of ['price', 'ENDING', 'startsAt', '', 'name:desc', ['ending'], 42, null]) {
      expect(() => parseEventSortMode(value)).toThrow(AppError);
    }
    try {
      parseEventSortMode('bogus');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).message).toContain('ending, date, price-asc, price-desc');
    }
  });
});

describe('event sort mapping', () => {
  it('maps date to a mongo sort and enrichment sorts to no mongo sort', () => {
    expect(buildEventSort('date')).toEqual({ startsAt: 1, _id: 1 });
    expect(buildEventSort('ending')).toBeNull();
    expect(buildEventSort('price-asc')).toBeNull();
    expect(buildEventSort('price-desc')).toBeNull();
  });
});

describe('event sort comparison', () => {
  it('orders ending by sale end, then start, with no sale window last', () => {
    const rows = [
      keys({ id: 'evt_no_sale', saleEndsAt: null }),
      keys({ id: 'evt_late', saleEndsAt: new Date('2026-02-25T18:00:00.000Z') }),
      keys({ id: 'evt_early', saleEndsAt: new Date('2026-02-10T18:00:00.000Z') }),
      keys({
        id: 'evt_early_later_start',
        saleEndsAt: new Date('2026-02-10T18:00:00.000Z'),
        startsAt: new Date('2026-03-05T19:00:00.000Z'),
      }),
    ];
    expect(sortedIds('ending', rows)).toEqual([
      'evt_early',
      'evt_early_later_start',
      'evt_late',
      'evt_no_sale',
    ]);
  });

  it('orders date by start time only', () => {
    const rows = [
      keys({ id: 'evt_b', startsAt: new Date('2026-03-02T19:00:00.000Z') }),
      keys({ id: 'evt_a', startsAt: new Date('2026-03-01T19:00:00.000Z') }),
    ];
    expect(sortedIds('date', rows)).toEqual(['evt_a', 'evt_b']);
  });

  it('orders price ascending with unpriced events last', () => {
    const rows = [
      keys({ id: 'evt_free', minPrice: null }),
      keys({ id: 'evt_expensive', minPrice: 500000 }),
      keys({ id: 'evt_cheap', minPrice: 50000 }),
    ];
    expect(sortedIds('price-asc', rows)).toEqual(['evt_cheap', 'evt_expensive', 'evt_free']);
  });

  it('orders price descending with unpriced events last', () => {
    const rows = [
      keys({ id: 'evt_free', minPrice: null }),
      keys({ id: 'evt_expensive', minPrice: 500000 }),
      keys({ id: 'evt_cheap', minPrice: 50000 }),
    ];
    expect(sortedIds('price-desc', rows)).toEqual(['evt_expensive', 'evt_cheap', 'evt_free']);
  });

  it('breaks full ties by id so the order is deterministic', () => {
    const rows = [
      keys({ id: 'evt_b', saleEndsAt: null, minPrice: null }),
      keys({ id: 'evt_a', saleEndsAt: null, minPrice: null }),
    ];
    expect(sortedIds('ending', rows)).toEqual(['evt_a', 'evt_b']);
    expect(sortedIds('price-asc', rows)).toEqual(['evt_a', 'evt_b']);
    expect(sortedIds('date', rows)).toEqual(['evt_a', 'evt_b']);
  });
});

describe('event sort cursor round-trip', () => {
  it('encodes and decodes the sort keys unchanged', () => {
    const original = keys({ id: 'evt_9', minPrice: 250000 });
    const decoded = eventSortKeysFromCursor(eventSortKeysToCursor(original));
    expect(decoded).toEqual(original);
    expect(eventSortKeysToCursor(keys({ saleEndsAt: null, minPrice: null }))).toEqual({
      saleEndsAt: null,
      startsAt: '2026-03-01T19:00:00.000Z',
      minPrice: null,
      _id: 'evt_1',
    });
  });

  it('marks the cursor scope with the sort mode', () => {
    expect(eventSortCursorScope('ending')).toBe('sort:ending');
    expect(eventSortCursorScope('price-desc')).toBe('sort:price-desc');
  });

  it('rejects malformed cursor sort payloads with a 400', () => {
    const malformed: unknown[] = [
      null,
      'not-an-object',
      {},
      { startsAt: 'not-a-date', saleEndsAt: null, minPrice: null, _id: 'evt_1' },
      { startsAt: '2026-03-01T19:00:00.000Z', minPrice: null, _id: 'evt_1' },
      { startsAt: '2026-03-01T19:00:00.000Z', saleEndsAt: 'bad', minPrice: null, _id: 'evt_1' },
      { startsAt: '2026-03-01T19:00:00.000Z', saleEndsAt: null, minPrice: 'cheap', _id: 'evt_1' },
      { startsAt: '2026-03-01T19:00:00.000Z', saleEndsAt: null, minPrice: null, _id: '' },
    ];
    for (const value of malformed) {
      expect(() => eventSortKeysFromCursor(value)).toThrow(AppError);
    }
  });
});
