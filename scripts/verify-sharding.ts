import type { Document } from 'mongodb';
import { getEnv } from '../src/config/env.ts';
import { connectMongo, getCollectionShardKey } from '../src/infra/db/client.ts';
import { SHARDED_COLLECTIONS } from '../src/infra/db/collections.ts';

const EXPECTED_UNIQUE_PREFIX = 'userId';

interface CollectionReport {
  collection: string;
  sharded: boolean;
  shardKey: Document | null;
  uniqueIndexes: Array<{ name: string; key: Document; compatible: boolean }>;
  documents: number;
  shardDistribution: Record<string, number>;
}

const main = async (): Promise<void> => {
  const env = getEnv();
  const mongo = await connectMongo(env);

  try {
    const shardsResult: Document = await mongo.db.admin().command({ listShards: 1 });
    const shards = Array.isArray(shardsResult.shards)
      ? (shardsResult.shards as Document[]).map((shard) => String(shard._id))
      : [];

    const reports: CollectionReport[] = [];
    for (const collection of SHARDED_COLLECTIONS) {
      const shardKey = await getCollectionShardKey(mongo.db, collection);

      const indexes = await mongo.db.collection(collection).indexes();
      const uniqueIndexes = indexes
        .filter((index) => index.unique === true)
        .map((index) => {
          const key = index.key as Document;
          return {
            name: String(index.name ?? 'unnamed'),
            key,
            compatible: Object.keys(key)[0] === EXPECTED_UNIQUE_PREFIX,
          };
        });

      const distribution: Record<string, number> = {};
      try {
        const stats = await mongo.db
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
        // empty collection
      }

      reports.push({
        collection,
        sharded: shardKey !== null,
        shardKey,
        uniqueIndexes,
        documents: Object.values(distribution).reduce((total, value) => total + value, 0),
        shardDistribution: distribution,
      });
    }

    const problems: string[] = [];
    for (const report of reports) {
      if (!report.sharded) problems.push(`${report.collection}: collection is not sharded`);
      else if (Object.keys(report.shardKey ?? {}).join(',') !== 'userId') {
        problems.push(`${report.collection}: shard key is not { userId: 1 }`);
      }
      for (const index of report.uniqueIndexes) {
        if (!index.compatible) {
          problems.push(
            `${report.collection}: unique index ${index.name} does not start with ${EXPECTED_UNIQUE_PREFIX}`,
          );
        }
      }
    }

    const output = {
      database: env.MONGODB_DATABASE,
      mongosUri: env.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@'),
      shards,
      collections: reports,
      problems,
      ok: problems.length === 0 && shards.length >= 2,
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
  } finally {
    await mongo.close();
  }
};

await main();
