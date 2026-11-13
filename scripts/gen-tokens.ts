import { getEnv } from '../src/config/env.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { getCollections } from '../src/infra/db/collections.ts';
import { createUser, TokenService } from '../src/modules/auth/service.ts';

const USER_COUNT = Number(process.env.GEN_TOKEN_USERS ?? 20);

const main = async (): Promise<void> => {
  const env = getEnv();
  const mongo = await connectMongo(env);
  const collections = getCollections(mongo.db);
  const tokens = new TokenService(env, collections);

  try {
    const output: Array<{
      userId: string;
      email: string;
      accessToken: string;
      refreshToken: string;
    }> = [];
    for (let index = 0; index < USER_COUNT; index += 1) {
      const email = `loadtest-${index}-${Date.now()}@tixwar.local`;
      const password = `LoadTest-${index}-2024`;
      const created = await createUser({ collections, email, password });
      output.push({
        userId: created.id,
        email,
        accessToken: await tokens.signAccessToken({ userId: created.id, role: 'user' }),
        refreshToken: await tokens.issueRefreshToken({ userId: created.id }),
      });
    }
    console.log(JSON.stringify({ users: output }, null, 2));
  } finally {
    await mongo.close();
  }
};

await main();
