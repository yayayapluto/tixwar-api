import { getEnv } from '../src/config/env.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { getCollections } from '../src/infra/db/collections.ts';
import { createUser, TokenService } from '../src/modules/auth/service.ts';

const USER_COUNT = Number(process.env.GEN_TOKEN_USERS ?? 20);

interface TokenEntry {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

const mintForExisting = async (count: number): Promise<TokenEntry[]> => {
  const env = getEnv();
  const mongo = await connectMongo(env);
  const collections = getCollections(mongo.db);
  const tokens = new TokenService(env, collections);
  try {
    const users = await collections.users
      .find({ email: { $regex: '^load-' }, role: 'user' })
      .limit(count)
      .toArray();
    const entries: TokenEntry[] = [];
    for (const user of users) {
      entries.push({
        userId: user._id,
        email: user.email,
        accessToken: await tokens.signAccessToken({ userId: user._id, role: 'user' }),
        refreshToken: await tokens.issueRefreshToken({ userId: user._id }),
      });
    }
    return entries;
  } finally {
    await mongo.close();
  }
};

const mintNewUsers = async (count: number): Promise<TokenEntry[]> => {
  const env = getEnv();
  const mongo = await connectMongo(env);
  const collections = getCollections(mongo.db);
  const tokens = new TokenService(env, collections);
  try {
    const entries: TokenEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const email = `loadtest-${index}-${Date.now()}@tixwar.local`;
      const created = await createUser({
        collections,
        email,
        password: `LoadTest-${index}-2024`,
      });
      entries.push({
        userId: created.id,
        email,
        accessToken: await tokens.signAccessToken({ userId: created.id, role: 'user' }),
        refreshToken: await tokens.issueRefreshToken({ userId: created.id }),
      });
    }
    return entries;
  } finally {
    await mongo.close();
  }
};

const main = async (): Promise<void> => {
  const useExisting = process.argv.includes('--existing');
  const users = useExisting ? await mintForExisting(USER_COUNT) : await mintNewUsers(USER_COUNT);
  console.log(
    JSON.stringify({ count: users.length, source: useExisting ? 'seed' : 'new', users }, null, 2),
  );
};

await main();
