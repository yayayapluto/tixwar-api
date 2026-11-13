import express, { type Express } from 'express';
import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';
import type { Env } from './config/env.ts';
import type { TraceContext } from './debug/trace.ts';
import type { PaymentGatewayClient } from './infra/breaker/gateway-client.ts';
import type { BreakerRegistry } from './infra/breaker/registry.ts';
import type { Collections } from './infra/db/collections.ts';
import type { QueueContext } from './infra/queue/queues.ts';
import type { CacheStore } from './infra/redis/cache.ts';
import type { PubSub } from './infra/redis/pubsub.ts';
import type { StockGate } from './infra/redis/stock.ts';
import type { StorageContext } from './infra/storage/minio.ts';
import { createAuthMiddleware, optionalAuth } from './middleware/auth.ts';
import { errorHandler, notFoundHandler } from './middleware/error.ts';
import type { IdempotencyStore } from './middleware/idempotency.ts';
import { createMetricsMiddleware } from './middleware/metrics.ts';
import type { RateLimiterSet } from './middleware/rateLimit.ts';
import { requestIdMiddleware } from './middleware/requestId.ts';
import { applySecurity } from './middleware/security.ts';
import { createSlowMotionMiddleware } from './middleware/slowMotion.ts';
import { createAuthRouter } from './modules/auth/routes.ts';
import type { TokenService } from './modules/auth/service.ts';
import { createDebugRouter } from './modules/debug/routes.ts';
import { createDocsRouter } from './modules/docs/routes.ts';
import { createEventsRouter } from './modules/events/routes.ts';
import type { EventService } from './modules/events/service.ts';
import { createHealthRouter } from './modules/health/routes.ts';
import type { NotificationService } from './modules/notifications/service.ts';
import { createOrdersRouter } from './modules/orders/routes.ts';
import type { OrderService } from './modules/orders/service.ts';
import type { PaymentService } from './modules/payments/service.ts';
import { createTicketsRouter } from './modules/tickets/routes.ts';
import type { TicketService } from './modules/tickets/service.ts';
import { createWebhooksRouter } from './modules/webhooks/routes.ts';
import type { WebhookService } from './modules/webhooks/service.ts';

export interface AppDeps {
  env: Env;
  collections: Collections;
  client: MongoClient;
  redis: Redis;
  subscriber: Redis;
  cache: CacheStore;
  pubsub: PubSub;
  stock: StockGate;
  breakers: BreakerRegistry;
  gateway: PaymentGatewayClient;
  storage: StorageContext;
  trace: TraceContext;
  queues: QueueContext;
  rateLimiters: RateLimiterSet;
  idempotency: IdempotencyStore;
  tokens: TokenService;
  events: EventService;
  orders: OrderService;
  payments: PaymentService;
  tickets: TicketService;
  notifications: NotificationService;
  webhooks: WebhookService;
  startedAt: Date;
  selfBaseUrl: string;
}

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  applySecurity(app, deps.env);
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: deps.env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: deps.env.BODY_LIMIT }));
  app.use(createMetricsMiddleware());
  app.use(createSlowMotionMiddleware(deps.env));

  const auth = createAuthMiddleware({ tokens: deps.tokens, collections: deps.collections });
  const maybeAuth = optionalAuth({ tokens: deps.tokens, collections: deps.collections });

  app.use(createHealthRouter(deps));
  app.use(createDocsRouter(deps));

  const v1 = express.Router();
  v1.use(maybeAuth);
  v1.use(createSlowMotionMiddleware(deps.env));
  v1.use('/auth', createAuthRouter(deps));
  v1.use('/events', createEventsRouter(deps, deps.events));
  v1.use(
    '/orders',
    createOrdersRouter(deps, {
      auth,
      maybeAuth,
      events: deps.events,
      orders: deps.orders,
      payments: deps.payments,
    }),
  );
  v1.use('/tickets', createTicketsRouter(deps, deps.tickets, auth));
  v1.use('/webhooks', createWebhooksRouter(deps, deps.webhooks, auth));
  app.use('/v1', v1);

  const debug = express.Router();
  debug.use(maybeAuth);
  debug.use(createSlowMotionMiddleware(deps.env));
  debug.use(createDebugRouter(deps, auth));
  app.use('/debug', debug);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
