import { getEnv } from '../src/config/env.ts';
import { replayDeadLetters } from '../src/events/publisher.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { getCollections } from '../src/infra/db/collections.ts';

const main = async (): Promise<void> => {
  const env = getEnv();
  const command = process.argv[2] ?? 'inspect';
  const mongo = await connectMongo(env);
  const collections = getCollections(mongo.db);

  try {
    if (command === 'inspect') {
      const deadLetters = await collections.outboxEvents
        .find({ status: 'DEAD_LETTER' })
        .sort({ createdAt: 1 })
        .limit(50)
        .toArray();
      const counts = await collections.outboxEvents
        .aggregate<{ _id: string; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .toArray();
      console.log(
        JSON.stringify(
          {
            counts: Object.fromEntries(counts.map((entry) => [entry._id, entry.count])),
            deadLetters: deadLetters.map((doc) => ({
              id: doc._id,
              type: doc.type,
              attempts: doc.attempts,
              lastError: doc.lastError,
              createdAt: doc.createdAt.toISOString(),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === 'replay') {
      const limit = Number(process.argv[3] ?? 100);
      const result = await replayDeadLetters(collections, limit);
      console.log(JSON.stringify({ replayed: result.replayed }, null, 2));
      return;
    }

    console.error(`unknown command: ${command} (use inspect|replay)`);
    process.exitCode = 1;
  } finally {
    await mongo.close();
  }
};

await main();
