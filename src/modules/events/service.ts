import type { Env } from '../../config/env.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { EventDoc, TicketTierDoc } from '../../infra/db/types.ts';
import type { CacheStore } from '../../infra/redis/cache.ts';
import { decodeCursor, encodeCursor } from '../../shared/cursor.ts';
import { hashRequest } from '../../shared/hash.ts';
import { type ApiEnvelope, buildEnvelope } from '../../shared/http.ts';
import { newEventId, newTierId } from '../../shared/ids.ts';
import { badRequest, notFound } from '../../shared/problem.ts';
import {
  buildEventFilter,
  buildEventSort,
  buildProjection,
  type EventListQuery,
  type EventTierSummary,
  normalizeCacheQuery,
  pickFields,
  serializeEvent,
  serializeEventWithPrice,
} from './query.ts';

export interface EventListResult {
  data: Array<Record<string, unknown>>;
  page?: number;
  limit: number;
  total?: number;
  nextCursor: string | null;
  hasMore: boolean;
  cacheHit: boolean;
}

export interface EventServiceDeps {
  collections: Collections;
  cache: CacheStore;
  env: Env;
}

const PRICE_TIER_LOOKUP_LIMIT = 500;

const resolveTierIdsByPrice = async (
  collections: Collections,
  query: EventListQuery,
): Promise<string[] | undefined> => {
  if (query.price_min === undefined && query.price_max === undefined) return undefined;
  const range: Record<string, number> = {};
  if (query.price_min !== undefined) range.$gte = query.price_min;
  if (query.price_max !== undefined) range.$lte = query.price_max;
  const tiers = await collections.ticketTiers
    .find({ price: range }, { projection: { eventId: 1 }, limit: PRICE_TIER_LOOKUP_LIMIT })
    .toArray();
  return Array.from(new Set(tiers.map((tier) => tier.eventId)));
};

const loadTierSummaries = async (
  collections: Collections,
  eventIds: string[],
): Promise<Map<string, EventTierSummary>> => {
  const summaries = new Map<string, EventTierSummary>();
  if (eventIds.length === 0) return summaries;
  const rows = await collections.ticketTiers
    .aggregate<{
      _id: string;
      minPrice: number;
      maxPrice: number;
      saleEndsAt: Date | null;
      totalQuota: number;
    }>([
      { $match: { eventId: { $in: eventIds } } },
      {
        $group: {
          _id: '$eventId',
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          saleEndsAt: { $min: '$saleEndsAt' },
          totalQuota: { $sum: '$quota' },
        },
      },
    ])
    .toArray();
  for (const row of rows) {
    summaries.set(row._id, {
      minPrice: row.minPrice,
      maxPrice: row.maxPrice,
      saleEndsAt: row.saleEndsAt,
      totalQuota: row.totalQuota,
    });
  }
  return summaries;
};

const loadSoldCounts = async (
  collections: Collections,
  eventIds: string[],
): Promise<Map<string, number>> => {
  const sold = new Map<string, number>();
  if (eventIds.length === 0) return sold;
  const rows = await collections.tickets
    .aggregate<{ _id: string; totalSold: number }>([
      { $match: { eventId: { $in: eventIds } } },
      { $group: { _id: '$eventId', totalSold: { $sum: 1 } } },
    ])
    .toArray();
  for (const row of rows) sold.set(row._id, row.totalSold);
  return sold;
};

const serializeTier = (tier: TicketTierDoc): Record<string, unknown> => ({
  id: tier._id,
  eventId: tier.eventId,
  name: tier.name,
  price: tier.price,
  quota: tier.quota,
  saleStartsAt: tier.saleStartsAt.toISOString(),
  saleEndsAt: tier.saleEndsAt.toISOString(),
  maxPerUser: tier.maxPerUser,
});

export class EventService {
  private readonly collections: Collections;
  private readonly cache: CacheStore;
  private readonly env: Env;

  constructor(deps: EventServiceDeps) {
    this.collections = deps.collections;
    this.cache = deps.cache;
    this.env = deps.env;
  }

  async list(query: EventListQuery, selfPath: string): Promise<EventListResult> {
    const version = await this.cache.getVersion('events');
    const cacheKey = `events:list:v${version}:${hashRequest(normalizeCacheQuery(query))}`;
    const cached = await this.cache.remember<Omit<EventListResult, 'cacheHit'>>(
      cacheKey,
      'events-list',
      () => this.loadList(query, selfPath),
      { ttlSeconds: this.env.CACHE_LIST_TTL_SECONDS },
    );
    if (!cached.value) throw notFound('Event list is unavailable');
    return { ...cached.value, cacheHit: cached.hit };
  }

  private async serializeListPage(
    docs: EventDoc[],
    fields?: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const eventIds = docs.map((doc) => doc._id);
    const [summaries, soldCounts] = await Promise.all([
      loadTierSummaries(this.collections, eventIds),
      loadSoldCounts(this.collections, eventIds),
    ]);
    return docs.map((doc) => {
      const summary = summaries.get(doc._id);
      const totalQuota = summary?.totalQuota ?? 0;
      const totalSold = soldCounts.get(doc._id) ?? 0;
      return pickFields(
        serializeEventWithPrice(doc, summary, {
          saleEndsAt: summary?.saleEndsAt?.toISOString() ?? null,
          totalQuota,
          totalSold,
          remaining: Math.max(0, totalQuota - totalSold),
        }),
        fields,
      );
    });
  }

  private async loadList(
    query: EventListQuery,
    _selfPath: string,
  ): Promise<Omit<EventListResult, 'cacheHit'> | null> {
    const tierEventIds = await resolveTierIdsByPrice(this.collections, query);
    const filter = buildEventFilter(query, tierEventIds);
    const sort = buildEventSort(query.sort);
    const projection = buildProjection(query.fields);
    const readPreference = 'secondaryPreferred' as const;

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const sortEntries = Object.entries(sort);
      const conditions: Array<Record<string, unknown>> = [];
      for (let index = 0; index < sortEntries.length; index += 1) {
        const condition: Record<string, unknown> = {};
        for (let prefix = 0; prefix < index; prefix += 1) {
          const [prefixField] = sortEntries[prefix]!;
          const cursorSort = cursor.sort as Record<string, unknown>;
          condition[prefixField] = cursorSort[prefixField];
        }
        const [field, direction] = sortEntries[index]!;
        const cursorSort = cursor.sort as Record<string, unknown>;
        condition[field] = { [direction === 1 ? '$gt' : '$lt']: cursorSort[field] };
        conditions.push(condition);
      }
      const cursorFilter = { ...filter, $or: conditions } as typeof filter;
      const docs = await this.collections.events
        .find(cursorFilter, { readPreference, ...(projection ? { projection } : {}) })
        .sort(sort)
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = docs.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              sort: Object.fromEntries(
                Object.keys(sort).map((field) => [
                  field,
                  field === '_id' ? last._id : (last as unknown as Record<string, unknown>)[field],
                ]),
              ),
              id: last._id,
            })
          : null;
      return {
        data: await this.serializeListPage(page, query.fields),
        limit: query.limit,
        nextCursor,
        hasMore,
      };
    }

    const page = query.page ?? 1;
    const skip = (page - 1) * query.limit;
    const [docs, total] = await Promise.all([
      this.collections.events
        .find(filter, { readPreference, ...(projection ? { projection } : {}) })
        .sort(sort)
        .skip(skip)
        .limit(query.limit)
        .toArray(),
      this.collections.events
        .countDocuments(filter, { maxTimeMS: 2000, readPreference })
        .catch(() => -1),
    ]);

    return {
      data: await this.serializeListPage(docs, query.fields),
      page,
      limit: query.limit,
      total: total >= 0 ? total : undefined,
      nextCursor: null,
      hasMore: total >= 0 ? skip + docs.length < total : docs.length === query.limit,
    };
  }

  async getById(
    eventId: string,
    options: { include?: string[]; ifNoneMatch?: string } = {},
  ): Promise<{ body: ApiEnvelope<Record<string, unknown>>; etag: string; notModified: boolean }> {
    const version = await this.cache.getEventVersion(eventId);
    const includeTiers = options.include?.includes('tiers') ?? false;
    const cacheKey = `event:detail:${eventId}:v${version}:tiers=${includeTiers ? 1 : 0}`;

    const cached = await this.cache.remember<Record<string, unknown>>(
      cacheKey,
      'event-detail',
      async () => {
        const doc = await this.collections.events.findOne({
          _id: eventId,
          deletedAt: null,
        });
        if (!doc) return null;
        const payload = serializeEvent(doc);
        if (includeTiers) {
          const tiers = await this.collections.ticketTiers
            .find({ eventId })
            .sort({ saleStartsAt: 1, _id: 1 })
            .toArray();
          payload.tiers = tiers.map(serializeTier);
        }
        return payload;
      },
      { ttlSeconds: this.env.CACHE_DETAIL_TTL_SECONDS },
    );

    if (!cached.value) throw notFound('Event not found');

    const etag = `"ev-${eventId}-${version}-${hashRequest(cached.value).slice(0, 16)}"`;
    const notModified = options.ifNoneMatch === etag;
    return {
      body: buildEnvelope({
        data: cached.value,
        self: `/v1/events/${eventId}`,
        limit: 1,
      }),
      etag,
      notModified,
    };
  }

  async create(
    input: {
      name: string;
      description: string;
      category: string;
      city: string;
      venue: string;
      startsAt: Date;
      status: EventDoc['status'];
    },
    actorId: string,
  ): Promise<EventDoc> {
    const now = new Date();
    const doc: EventDoc = {
      _id: newEventId(),
      name: input.name,
      description: input.description,
      category: input.category.toLowerCase(),
      city: input.city.toLowerCase(),
      venue: input.venue,
      startsAt: input.startsAt,
      status: input.status,
      searchText: `${input.name} ${input.description}`.toLowerCase(),
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.collections.events.insertOne(doc, { writeConcern: { w: 'majority' } });
    await this.cache.invalidateEvents();
    return doc;
  }

  async patch(
    eventId: string,
    patch: Partial<
      Pick<EventDoc, 'name' | 'description' | 'category' | 'city' | 'venue' | 'startsAt' | 'status'>
    >,
  ): Promise<EventDoc> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === 'description' && value === '') {
        unset[key] = '';
        continue;
      }
      set[key] = key === 'category' || key === 'city' ? String(value).toLowerCase() : value;
    }
    if (typeof patch.name === 'string' || typeof patch.description === 'string') {
      const existing = await this.collections.events.findOne({ _id: eventId, deletedAt: null });
      if (!existing) throw notFound('Event not found');
      set.searchText =
        `${patch.name ?? existing.name} ${patch.description ?? existing.description}`.toLowerCase();
    }

    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const result = await this.collections.events.findOneAndUpdate(
      { _id: eventId, deletedAt: null },
      update,
      { returnDocument: 'after', writeConcern: { w: 'majority' } },
    );
    if (!result) throw notFound('Event not found');
    await this.cache.invalidateEvent(eventId);
    return result;
  }

  async softDelete(eventId: string): Promise<void> {
    const result = await this.collections.events.updateOne(
      { _id: eventId, deletedAt: null },
      { $set: { deletedAt: new Date(), updatedAt: new Date(), status: 'ENDED' } },
      { writeConcern: { w: 'majority' } },
    );
    if (result.matchedCount === 0) throw notFound('Event not found');
    await this.cache.invalidateEvent(eventId);
  }

  async bulkCreateTiers(
    eventId: string,
    tiers: Array<Omit<TicketTierDoc, '_id' | 'eventId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<{ inserted: number; ids: string[] }> {
    const event = await this.collections.events.findOne({ _id: eventId, deletedAt: null });
    if (!event) throw notFound('Event not found');
    if (tiers.length === 0) throw badRequest('at least one tier is required');

    const now = new Date();
    const docs: TicketTierDoc[] = tiers.map((tier) => ({
      _id: newTierId(),
      eventId,
      name: tier.name,
      price: tier.price,
      quota: tier.quota,
      saleStartsAt: tier.saleStartsAt,
      saleEndsAt: tier.saleEndsAt,
      maxPerUser: tier.maxPerUser,
      createdAt: now,
      updatedAt: now,
    }));

    const result = await this.collections.ticketTiers.bulkWrite(
      docs.map((doc) => ({ insertOne: { document: doc } })),
      { ordered: true, writeConcern: { w: 'majority' } },
    );
    await this.cache.invalidateEvent(eventId);
    return { inserted: result.insertedCount, ids: docs.map((doc) => doc._id) };
  }

  async listTiers(eventId: string): Promise<TicketTierDoc[]> {
    return this.collections.ticketTiers.find({ eventId }).sort({ saleStartsAt: 1 }).toArray();
  }

  async findTier(tierId: string): Promise<TicketTierDoc | null> {
    return this.collections.ticketTiers.findOne({ _id: tierId });
  }
}
