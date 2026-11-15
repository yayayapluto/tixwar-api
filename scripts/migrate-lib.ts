import type { Db } from 'mongodb';
import { buildMigrations } from '../migrations/index.ts';
import type { Env } from '../src/config/env.ts';
import { createLogger } from '../src/shared/logger.ts';

const logger = createLogger('migrate');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export const runMigrations = async (db: Db, env: Env): Promise<MigrationResult> => {
  const applied: string[] = [];
  const skipped: string[] = [];
  const state = db.collection<{ _id: string; appliedAt: Date; description: string }>(
    'schemaMigrations',
  );
  const done = new Set((await state.find({}).toArray()).map((entry) => entry._id));

  for (const migration of buildMigrations(env)) {
    if (done.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    logger.info({ id: migration.id }, 'applying migration');
    await migration.up(db);
    await state.updateOne(
      { _id: migration.id },
      { $set: { appliedAt: new Date(), description: migration.description } },
      { upsert: true },
    );
    applied.push(migration.id);
  }

  return { applied, skipped };
};
