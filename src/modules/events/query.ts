import type { Document, Filter } from 'mongodb';
import type { EventDoc } from '../../infra/db/types.ts';
import { badRequest } from '../../shared/problem.ts';

export interface EventListQuery {
  q?: string;
  category?: string;
  city?: string;
  status?: EventDoc['status'];
  date_from?: Date;
  date_to?: Date;
  price_min?: number;
  price_max?: number;
  sort?: Array<{ field: string; direction: 1 | -1 }>;
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

export const buildEventSort = (
  sort: Array<{ field: string; direction: 1 | -1 }> | undefined,
): Record<string, 1 | -1> => {
  const result: Record<string, 1 | -1> = {};
  if (!sort || sort.length === 0) {
    result.startsAt = 1;
    result._id = 1;
    return result;
  }
  for (const entry of sort) {
    result[entry.field] = entry.direction;
  }
  result._id = 1;
  return result;
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
