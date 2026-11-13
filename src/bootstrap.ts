import type { AppDeps } from './app.ts';
import type { Env } from './config/env.ts';
import { createTraceContext, type TraceContext } from './debug/trace.ts';
import { PaymentGatewayClient } from './infra/breaker/gateway-client.ts';
import { type BreakerRegistry, createBreakerRegistry } from './infra/breaker/registry.ts';
import { connectMongo, type MongoContext } from './infra/db/client.ts';
import { type Collections, getCollections } from './infra/db/collections.ts';
import { createQueues, type QueueContext } from './infra/queue/queues.ts';
import { CacheStore } from './infra/redis/cache.ts';
import { connectRedis, type RedisContext } from './infra/redis/client.ts';
import { PubSub } from './infra/redis/pubsub.ts';
import { StockGate } from './infra/redis/stock.ts';
import { connectStorage, type StorageContext } from './infra/storage/minio.ts';
import { IdempotencyStore } from './middleware/idempotency.ts';
import { createRateLimiters, type RateLimiterSet } from './middleware/rateLimit.ts';
import { TokenService } from './modules/auth/service.ts';
import { EventService } from './modules/events/service.ts';
import { NotificationService } from './modules/notifications/service.ts';
import { OrderService } from './modules/orders/service.ts';
import { PaymentService } from './modules/payments/service.ts';
import { TicketService } from './modules/tickets/service.ts';
import { WebhookService } from './modules/webhooks/service.ts';
import { createLogger } from './shared/logger.ts';

const logger = createLogger('bootstrap');

export interface Container extends AppDeps {
  mongo: MongoContext;
  redisCtx: RedisContext;
  shutdown: () => Promise<void>;
}

export const createContainer = async (env: Env): Promise<Container> => {
  const mongo = await connectMongo(env);
  const redisCtx = await connectRedis(env);
  const collections = getCollections(mongo.db);

  const cache = new CacheStore(redisCtx.client, env);
  const pubsub = new PubSub(redisCtx.client, redisCtx.subscriber);
  const stock = new StockGate(redisCtx.client);
  const breakers = createBreakerRegistry(env);
  const gateway = new PaymentGatewayClient(env, breakers);
  const storage = await connectStorage(env);
  await storage.ensureBucket();
  const queues = createQueues(env, redisCtx.client);
  const trace = createTraceContext({
    redis: redisCtx.client,
    db: mongo.db,
    channel: env.TRACE_CHANNEL,
    enabled: env.DEBUG_ENABLED,
  });
  const rateLimiters = createRateLimiters(env, redisCtx.client);
  const idempotency = new IdempotencyStore(collections, redisCtx.client);
  const tokens = new TokenService(env, collections);

  const events = new EventService({ collections, cache, env });
  const orders = new OrderService({
    env,
    collections,
    client: mongo.client,
    stock,
    cache,
    pubsub,
  });
  const payments = new PaymentService({
    env,
    collections,
    client: mongo.client,
    pubsub,
  });
  const tickets = new TicketService({
    collections,
    client: mongo.client,
    storage,
    breakers,
    pubsub,
  });
  const notifications = new NotificationService({ env, collections, breakers });
  const webhooks = new WebhookService({ env, collections, breakers });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down container');
    await Promise.allSettled([
      queues.close(),
      rateLimiters.close(),
      storage.client ? Promise.resolve() : Promise.resolve(),
    ]);
    await Promise.allSettled([redisCtx.close(), mongo.close()]);
  };

  return {
    env,
    collections,
    client: mongo.client,
    redis: redisCtx.client,
    subscriber: redisCtx.subscriber,
    cache,
    pubsub,
    stock,
    breakers,
    gateway,
    storage,
    trace,
    queues,
    rateLimiters,
    idempotency,
    tokens,
    events,
    orders,
    payments,
    tickets,
    notifications,
    webhooks,
    startedAt: new Date(),
    selfBaseUrl: `http://127.0.0.1:${env.PORT}`,
    mongo,
    redisCtx,
    shutdown,
  };
};

export const bootstrapDeps = async (env: Env): Promise<Container> => createContainer(env);

export type {
  BreakerRegistry,
  Collections,
  QueueContext,
  RateLimiterSet,
  StorageContext,
  TraceContext,
};
