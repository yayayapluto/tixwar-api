import type { Db, Document } from 'mongodb';
import { getEnv } from '../src/config/env.ts';
import { connectMongo, getCollectionShardKey } from '../src/infra/db/client.ts';

const SHARDED_COLLECTIONS = [
  'orders',
  'payments',
  'tickets',
  'outboxEvents',
  'processedEvents',
  'auditLogs',
];

const TARGET_KEY: Document = { userId: 1 };

interface ShardStatus {
  collection: string;
  sharded: boolean;
  shardKey: Document | null;
  chunks: number;
  documents: number;
  shardDistribution: Record<string, number>;
  targetKey: Document;
  needsReshard: boolean;
}

const inspect = async (db: Db): Promise<ShardStatus[]> => {
  const results: ShardStatus[] = [];
  for (const collection of SHARDED_COLLECTIONS) {
    const shardKey = await getCollectionShardKey(db, collection);

    const distribution: Record<string, number> = {};
    try {
      const stats = await db
        .collection(collection)
        .aggregate<{ shard: string; count: number }>([
          { $collStats: { storageStats: {} } },
          { $group: { _id: '$shard', count: { $sum: '$storageStats.count' } } },
          { $project: { _id: 0, shard: '$_id', count: 1 } },
        ])
        .toArray();
      for (const item of stats) {
        if (item.shard) distribution[item.shard] = item.count;
      }
    } catch {
      // collection may be empty or unsharded
    }

    const chunks = await db.client
      .db('config')
      .collection('chunks')
      .countDocuments({ ns: `${db.databaseName}.${collection}` })
      .catch(() => 0);

    const documents = Object.values(distribution).reduce((total, value) => total + value, 0);

    results.push({
      collection,
      sharded: shardKey !== null,
      shardKey,
      chunks,
      documents,
      shardDistribution: distribution,
      targetKey: TARGET_KEY,
      needsReshard: shardKey === null || Object.keys(shardKey).join(',') !== 'userId',
    });
  }
  return results;
};

const main = async (): Promise<void> => {
  const env = getEnv();
  const execute = process.argv.includes('--execute');
  const mongo = await connectMongo(env);

  try {
    const before = await inspect(mongo.db);
    const pending = before.filter((entry) => entry.needsReshard);

    if (!execute) {
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            database: env.MONGODB_DATABASE,
            targetShardKey: TARGET_KEY,
            collections: before,
            needsReshard: pending.map((entry) => entry.collection),
            hint: 'pass --execute to run reshardCollection for collections whose shard key differs',
          },
          null,
          2,
        ),
      );
      return;
    }

    const executed: Array<{ collection: string; result: string }> = [];
    for (const entry of pending) {
      try {
        await mongo.db.admin().command({
          reshardCollection: `${env.MONGODB_DATABASE}.${entry.collection}`,
          key: TARGET_KEY,
        });
        executed.push({ collection: entry.collection, result: 'resharded' });
      } catch (error) {
        executed.push({
          collection: entry.collection,
          result: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const after = await inspect(mongo.db);
    console.log(JSON.stringify({ mode: 'execute', executed, verification: after }, null, 2));
  } finally {
    await mongo.close();
  }
};

await main();
