import type { Db, Document } from 'mongodb';
import { SHARDED_COLLECTIONS } from '../src/infra/db/collections.ts';
import type { MigrationStep } from './types.ts';

export const SHARD_KEY: Document = { userId: 1 };

const isShardedCluster = async (db: Db): Promise<boolean> => {
  try {
    const hello: Document = await db.admin().command({ hello: 1 });
    return hello.msg === 'isdbgrid';
  } catch {
    return false;
  }
};

const isCollectionSharded = async (db: Db, collection: string): Promise<boolean> => {
  const entry = await db.client
    .db('config')
    .collection<{ _id: string; dropped?: boolean }>('collections')
    .findOne({ _id: `${db.databaseName}.${collection}`, dropped: { $ne: true } });
  return entry !== null;
};

export const shardCollections = async (
  db: Db,
): Promise<{ sharded: string[]; skipped: boolean }> => {
  if (!(await isShardedCluster(db))) {
    return { sharded: [], skipped: true };
  }

  try {
    await db.admin().command({ enableSharding: db.databaseName });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 23) throw error;
  }

  const sharded: string[] = [];
  for (const collection of SHARDED_COLLECTIONS) {
    if (await isCollectionSharded(db, collection)) continue;
    await db.admin().command({
      shardCollection: `${db.databaseName}.${collection}`,
      key: SHARD_KEY,
    });
    sharded.push(collection);
  }
  return { sharded, skipped: false };
};

export const createShardCollectionsMigration: MigrationStep = {
  id: '004-shard-collections',
  description: 'Enable database sharding and shard transaction collections on { userId: 1 }',
  up: async (db: Db) => {
    await shardCollections(db);
  },
};
