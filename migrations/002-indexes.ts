import type { Db, IndexDescription } from 'mongodb';
import type { MigrationStep } from './types.ts';

const INDEXES: Record<string, IndexDescription[]> = {
  users: [
    { key: { email: 1 }, name: 'uniq_email', unique: true },
    { key: { role: 1 }, name: 'role' },
  ],
  refreshTokens: [
    { key: { tokenHash: 1 }, name: 'uniq_token_hash', unique: true },
    { key: { userId: 1, family: 1 }, name: 'user_family' },
    { key: { expiresAt: 1 }, name: 'ttl_expires_at', expireAfterSeconds: 0 },
  ],
  apiKeys: [
    { key: { keyHash: 1 }, name: 'uniq_key_hash', unique: true },
    { key: { ownerId: 1, active: 1 }, name: 'owner_active' },
  ],
  events: [
    {
      key: { name: 'text', description: 'text' },
      name: 'text_search',
      weights: { name: 10, description: 3 },
    },
    { key: { status: 1, startsAt: 1 }, name: 'status_starts' },
    { key: { category: 1, startsAt: 1 }, name: 'category_starts' },
    { key: { city: 1, startsAt: 1 }, name: 'city_starts' },
    { key: { startsAt: 1, _id: 1 }, name: 'starts_id' },
    { key: { deletedAt: 1 }, name: 'deleted_at' },
  ],
  ticketTiers: [
    { key: { eventId: 1, saleStartsAt: 1 }, name: 'event_sale_start' },
    { key: { eventId: 1, _id: 1 }, name: 'event_id' },
  ],
  orders: [
    { key: { userId: 1, _id: 1 }, name: 'uniq_user_id', unique: true },
    { key: { userId: 1, createdAt: -1, _id: -1 }, name: 'user_created' },
    { key: { userId: 1, status: 1 }, name: 'user_status' },
    { key: { userId: 1, tierId: 1, status: 1 }, name: 'user_tier_status' },
    { key: { status: 1, expiresAt: 1 }, name: 'status_expires' },
  ],
  payments: [
    { key: { userId: 1, _id: 1 }, name: 'uniq_user_id', unique: true },
    { key: { userId: 1, orderId: 1 }, name: 'user_order' },
    { key: { status: 1, updatedAt: 1 }, name: 'status_updated' },
  ],
  tickets: [
    { key: { userId: 1, _id: 1 }, name: 'uniq_user_id', unique: true },
    { key: { userId: 1, code: 1 }, name: 'uniq_user_code', unique: true },
    { key: { userId: 1, orderId: 1 }, name: 'user_order' },
  ],
  outboxEvents: [
    { key: { userId: 1, _id: 1 }, name: 'uniq_user_id', unique: true },
    { key: { userId: 1, status: 1, createdAt: 1 }, name: 'user_status_created' },
    { key: { status: 1, leaseUntil: 1 }, name: 'status_lease' },
  ],
  processedEvents: [
    { key: { userId: 1, eventId: 1, consumer: 1 }, name: 'uniq_event_consumer', unique: true },
  ],
  auditLogs: [
    { key: { userId: 1, createdAt: -1 }, name: 'user_created' },
    { key: { entity: 1, entityId: 1 }, name: 'entity' },
  ],
  webhookEndpoints: [
    { key: { ownerId: 1, active: 1 }, name: 'owner_active' },
    { key: { url: 1 }, name: 'url' },
  ],
  idempotencyKeys: [
    { key: { scope: 1, ownerId: 1, key: 1 }, name: 'uniq_scope_owner_key', unique: true },
    { key: { expiresAt: 1 }, name: 'ttl_expires_at', expireAfterSeconds: 0 },
  ],
  eventStats: [{ key: { eventId: 1 }, name: 'uniq_event', unique: true }],
};

export const createIndexesMigration: MigrationStep = {
  id: '002-indexes',
  description: 'Create compound, unique and TTL indexes compatible with the userId shard key',
  up: async (db: Db) => {
    for (const [collection, indexes] of Object.entries(INDEXES)) {
      for (const index of indexes) {
        const options: Record<string, unknown> = { name: index.name };
        if (index.unique !== undefined) options.unique = index.unique;
        if (index.expireAfterSeconds !== undefined)
          options.expireAfterSeconds = index.expireAfterSeconds;
        if (index.weights !== undefined) options.weights = index.weights;
        await db.collection(collection).createIndex(index.key, options);
      }
    }
  },
};

export const INDEX_SPEC = INDEXES;
