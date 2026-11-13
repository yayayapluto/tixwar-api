import { getEnv } from '../src/config/env.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { runMigrations } from './migrate-lib.ts';

const main = async (): Promise<void> => {
  const env = getEnv();
  const mongo = await connectMongo(env);
  try {
    const result = await runMigrations(mongo.db, env);
    console.log(
      JSON.stringify(
        { applied: result.applied, skipped: result.skipped, database: env.MONGODB_DATABASE },
        null,
        2,
      ),
    );
  } finally {
    await mongo.close();
  }
};

await main();
