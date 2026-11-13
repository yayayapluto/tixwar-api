import type { Redis } from 'ioredis';
import RedisClient from 'ioredis';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('redis');

export interface RedisContext {
  client: Redis;
  subscriber: Redis;
  close: () => Promise<void>;
}

export const createRedisClient = (env: Env, role: string): Redis => {
  const client = new RedisClient(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `tixwar-${role}`,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  client.on('error', (error) => {
    logger.warn({ err: error, role }, 'redis error');
  });
  return client;
};

export const connectRedis = async (env: Env): Promise<RedisContext> => {
  const client = createRedisClient(env, 'main');
  const subscriber = createRedisClient(env, 'sub');
  await client.ping();
  logger.info('redis connected');
  return {
    client,
    subscriber,
    close: async () => {
      await Promise.allSettled([client.quit(), subscriber.quit()]);
    },
  };
};

export const pingRedis = async (client: Redis): Promise<boolean> => {
  try {
    const reply = await client.ping();
    return reply === 'PONG';
  } catch (error) {
    logger.warn({ err: error }, 'redis ping failed');
    return false;
  }
};
