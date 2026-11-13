import type { Db } from 'mongodb';
import type { Env } from '../src/config/env.ts';
import { collectionExists, createCollectionIfMissing, type MigrationStep } from './types.ts';

const REGULAR_COLLECTIONS = [
  'users',
  'refreshTokens',
  'apiKeys',
  'events',
  'ticketTiers',
  'orders',
  'payments',
  'tickets',
  'outboxEvents',
  'processedEvents',
  'auditLogs',
  'webhookEndpoints',
  'idempotencyKeys',
  'eventStats',
] as const;

export const createCollectionsMigration = (env: Env): MigrationStep => ({
  id: '001-init-collections',
  description: 'Create regular collections and the requestTraces time-series collection',
  up: async (db: Db) => {
    for (const name of REGULAR_COLLECTIONS) {
      await createCollectionIfMissing(db, name);
    }
    if (!(await collectionExists(db, 'requestTraces'))) {
      await db.createCollection('requestTraces', {
        timeseries: {
          timeField: 'ts',
          metaField: 'meta',
          granularity: 'seconds',
        },
        expireAfterSeconds: env.TRACE_TTL_DAYS * 86400,
      });
    }
  },
});
