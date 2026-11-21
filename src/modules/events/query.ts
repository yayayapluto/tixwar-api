import type { Document, Filter } from 'mongodb';
import { z } from 'zod';
import type { EventDoc } from '../../infra/db/types.ts';
import { badRequest } from '../../shared/problem.ts';

export const EVENT_SORT_MODES = ['ending', 'date', 'price-asc', 'price-desc'] as const;
export type EventSortMode = (typeof EVENT_SORT_MODES)[number];
export const DEFAULT_EVENT_SORT_MODE: EventSortMode = 'ending';

export const eventSortModeSchema = z.enum(EVENT_SORT_MODES);

export const parseEventSortMode = (value: unknown): EventSortMode => {
  if (value === undefined) return DEFAULT_EVENT_SORT_MODE;
  const parsed = eventSortModeSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`sort must be one of ${EVENT_SORT_MODES.join(', ')}`);
  }
  return parsed.data;
};

export interface EventListQuery {
  q?: string;
  category?: string;
  city?: string;
  status?: EventDoc['status'];
  date_from?: Date;
  date_to?: Date;
  price_min?: number;
  price_max?: number;
  sort?: EventSortMode;
  fields?: string[];
  include?: string[];
  page?: number;
  limit: number;
  cursor?: string;
}

const FORBIDDEN_KEY = /^\$|\.|__proto__|constructor|prototype/;
const SERVER_OWNED_OPERATORS = ['$text'];

export const assertSafeFilterKeys = (filter: Record<string, unknown>): void => {
  for (const key of Object.keys(filter)) {
    if (SERVER_OWNED_OPERATORS.includes(key)) continue;
    if (FORBIDDEN_KEY.test(key)) {
      throw badRequest(`query key "${key}" is not allowed`);
    }
  }
};

export const buildEventFilter = (
  query: EventListQuery,
  tierIdsForPrice?: string[],
): Filter<EventDoc> => {
  const filter: Record<string, unknown> = { deletedAt: null };

  if (query.q) filter.$text = { $search: query.q };
  if (query.category) filter.category = query.category;
  if (query.city) filter.city = query.city;
  if (query.status) filter.status = query.status;

  if (query.date_from || query.date_to) {
    const range: Record<string, Date> = {};
    if (query.date_from) range.$gte = query.date_from;
    if (query.date_to) range.$lte = query.date_to;
    filter.startsAt = range;
  }

  if (tierIdsForPrice && tierIdsForPrice.length > 0) {
    filter._id = { $in: tierIdsForPrice };
  }

  assertSafeFilterKeys(filter);
  return filter as Filter<EventDoc>;
};

export const buildEventSort = (sort: EventSortMode): Record<string, 1 | -1> | null => {
  if (sort === 'date') return { startsAt: 1, _id: 1 };
  return null;
};

export interface EventSortKeys {
  id: string;
  startsAt: Date;
  saleEndsAt: Date | null;
  minPrice: number | null;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareEventSortKeys = (
  mode: EventSortMode,
  left: EventSortKeys,
  right: EventSortKeys,
): number => {
  switch (mode) {
    case 'date':
      return (
        left.startsAt.getTime() - right.startsAt.getTime() || compareStrings(left.id, right.id)
      );
    case 'price-asc':
      return (
        (left.minPrice ?? Number.POSITIVE_INFINITY) -
          (right.minPrice ?? Number.POSITIVE_INFINITY) || compareStrings(left.id, right.id)
      );
    case 'price-desc':
      return (
        (right.minPrice ?? Number.NEGATIVE_INFINITY) -
          (left.minPrice ?? Number.NEGATIVE_INFINITY) || compareStrings(left.id, right.id)
      );
    default:
      return (
        (left.saleEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (right.saleEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
        left.startsAt.getTime() - right.startsAt.getTime() ||
        compareStrings(left.id, right.id)
      );
  }
};

export const eventSortCursorScope = (mode: EventSortMode): string => `sort:${mode}`;

export const eventSortKeysToCursor = (keys: EventSortKeys): Record<string, unknown> => ({
  saleEndsAt: keys.saleEndsAt?.toISOString() ?? null,
  startsAt: keys.startsAt.toISOString(),
  minPrice: keys.minPrice,
  _id: keys.id,
});

const parseCursorDate = (value: unknown): Date | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string') return new Date(value);
  return undefined;
};

export const eventSortKeysFromCursor = (sort: unknown): EventSortKeys => {
  if (typeof sort !== 'object' || sort === null) {
    throw badRequest('cursor does not match the requested sort');
  }
  const record = sort as Record<string, unknown>;
  const startsAt = parseCursorDate(record.startsAt);
  const saleEndsAt = parseCursorDate(record.saleEndsAt);
  const minPrice = record.minPrice;
  if (
    startsAt === undefined ||
    startsAt === null ||
    Number.isNaN(startsAt.getTime()) ||
    saleEndsAt === undefined ||
    (saleEndsAt !== null && Number.isNaN(saleEndsAt.getTime())) ||
    (minPrice !== null && (typeof minPrice !== 'number' || !Number.isFinite(minPrice))) ||
    typeof record._id !== 'string' ||
    record._id.length === 0
  ) {
    throw badRequest('cursor does not match the requested sort');
  }
  return { id: record._id, startsAt, saleEndsAt, minPrice };
};

export const buildProjection = (fields?: string[]): Document | undefined => {
  if (!fields || fields.length === 0) return undefined;
  const projection: Record<string, 1> = { _id: 1 };
  for (const field of fields) projection[field] = 1;
  return projection;
};

export const serializeEvent = (doc: EventDoc): Record<string, unknown> => ({
  id: doc._id,
  name: doc.name,
  description: doc.description,
  category: doc.category,
  city: doc.city,
  venue: doc.venue,
  startsAt: doc.startsAt.toISOString(),
  status: doc.status,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});

export interface EventPriceRange {
  minPrice: number | null;
  maxPrice: number | null;
}

export interface EventTierSummary extends EventPriceRange {
  saleEndsAt: Date | null;
  totalQuota: number;
}

export interface EventUrgency {
  saleEndsAt: string | null;
  totalQuota: number;
  totalSold: number;
  remaining: number;
}

export const serializeEventWithPrice = (
  doc: EventDoc,
  price?: EventPriceRange,
  urgency?: EventUrgency,
): Record<string, unknown> => ({
  ...serializeEvent(doc),
  minPrice: price?.minPrice ?? null,
  maxPrice: price?.maxPrice ?? null,
  saleEndsAt: urgency?.saleEndsAt ?? null,
  totalQuota: urgency?.totalQuota ?? 0,
  totalSold: urgency?.totalSold ?? 0,
  remaining: urgency?.remaining ?? 0,
});

export const pickFields = (
  serialized: Record<string, unknown>,
  fields?: string[],
): Record<string, unknown> => {
  if (!fields || fields.length === 0) return serialized;
  const result: Record<string, unknown> = { id: serialized.id };
  for (const field of fields) {
    if (field === 'id') continue;
    if (field in serialized) result[field] = serialized[field];
  }
  return result;
};

export const normalizeCacheQuery = (query: EventListQuery): Record<string, unknown> => ({
  q: query.q ?? null,
  category: query.category ?? null,
  city: query.city ?? null,
  status: query.status ?? null,
  date_from: query.date_from?.toISOString() ?? null,
  date_to: query.date_to?.toISOString() ?? null,
  price_min: query.price_min ?? null,
  price_max: query.price_max ?? null,
  sort: query.sort ?? null,
  fields: query.fields ? [...query.fields].sort() : null,
  include: query.include ? [...query.include].sort() : null,
  page: query.page ?? null,
  limit: query.limit,
  cursor: query.cursor ?? null,
});
