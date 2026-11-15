import './infra/tracing.ts';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { type Job, Worker } from 'bullmq';
import type { Container } from './bootstrap.ts';
import { createContainer } from './bootstrap.ts';
import { getEnv } from './config/env.ts';
import { buildHandlers } from './events/handlers.ts';
import { metrics } from './infra/metrics/registry.ts';
import { startMetricsServer } from './infra/metrics/server.ts';
import type { EventJobData } from './infra/queue/queues.ts';
import { QUEUE_NAMES, type QueueName, queueDepthFor, workerOptions } from './infra/queue/queues.ts';
import { stopTracing } from './infra/tracing.ts';
import { createLogger } from './shared/logger.ts';

const logger = createLogger('worker');

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const HANDLER_BY_QUEUE: Record<QueueName, string[]> = {
  order: ['order.created', 'order.paid', 'stock.released'],
  payment: ['payment.requested', 'payment.succeeded', 'payment.failed'],
  notification: ['order.confirmed', 'order.expired', 'order.cancelled', 'notification.email'],
  webhook: ['webhook.deliver'],
  expiry: [],
  dlq: [],
};

const main = async (): Promise<void> => {
  const env = getEnv();
  const container: Container = await createContainer(env);
  const handlers = buildHandlers({
    env,
    collections: container.collections,
    client: container.client,
    orders: container.orders,
    payments: container.payments,
    tickets: container.tickets,
    notifications: container.notifications,
    webhooks: container.webhooks,
    gateway: container.gateway,
    breakers: container.breakers,
    pubsub: container.pubsub,
  });

  const workers: Worker<EventJobData>[] = [];
  const dlq = container.queues.queues.dlq;

  for (const name of Object.values(QUEUE_NAMES)) {
    if (name === QUEUE_NAMES.dlq) continue;
    const queueName = `${env.QUEUE_PREFIX}-${name}`;
    const worker = new Worker<EventJobData>(
      queueName,
      async (job: Job<EventJobData>) => {
        const handler = handlers[job.data.type];
        if (!handler) {
          logger.warn({ type: job.data.type, jobId: job.id }, 'no handler registered');
          return;
        }
        const failureRateRaw = await container.redis.get('chaos:worker:failure-rate');
        const failureRate = failureRateRaw ? Number(failureRateRaw) : 0;
        if (failureRate > 0 && Math.random() * 100 < failureRate) {
          throw new Error('chaos: injected worker failure');
        }
        const startedAt = Date.now();
        const carrier = { traceparent: job.data.data.traceparent };
        const parentCtx =
          typeof job.data.data.traceparent === 'string'
            ? propagation.extract(context.active(), carrier)
            : context.active();
        const span = trace
          .getTracer('tixwar')
          .startSpan(`bullmq.${name}.${job.data.type}`, undefined, parentCtx);
        span.setAttribute('messaging.system', 'bullmq');
        span.setAttribute('messaging.destination', queueName);
        span.setAttribute('messaging.operation', 'process');
        try {
          await handler(job.data);
          span.setStatus({ code: SpanStatusCode.OK });
          await container.trace.record({
            requestId: job.data.requestId,
            node: 'worker',
            step: 'worker',
            status: 'ok',
            durationMs: Date.now() - startedAt,
            meta: { queue: name, type: job.data.type, jobId: job.id },
          });
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          await container.trace.record({
            requestId: job.data.requestId,
            node: 'worker',
            step: 'worker',
            status: 'error',
            durationMs: Date.now() - startedAt,
            meta: {
              queue: name,
              type: job.data.type,
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        } finally {
          span.end();
        }
      },
      workerOptions(env, name, container.redis),
    );

    worker.on('failed', (job, error) => {
      metrics.queueFailedTotal.inc({ queue: name });
      logger.warn({ queue: name, jobId: job?.id, err: error.message }, 'job failed');
      const attempts = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts.attempts ?? 5;
      if (attempts >= maxAttempts && job) {
        void dlq
          .add(job.data.type, job.data, { jobId: `dlq-${job.id}` })
          .then(() => logger.warn({ queue: name, jobId: job.id }, 'job moved to dead letter queue'))
          .catch((dlqError: unknown) =>
            logger.error({ err: dlqError, queue: name }, 'failed to move job to DLQ'),
          );
      }
    });

    workers.push(worker);
  }

  const depthLoop = async (): Promise<void> => {
    while (true) {
      for (const [name, queue] of Object.entries(container.queues.queues)) {
        try {
          metrics.queueDepth.set({ queue: name }, await queueDepthFor(queue));
        } catch {
          metrics.queueDepth.set({ queue: name }, -1);
        }
      }
      await sleep(5000);
    }
  };
  void depthLoop();

  const expiryLoop = async (): Promise<void> => {
    while (true) {
      try {
        const expired = await container.orders.expireDueOrders(50);
        if (expired.length > 0) logger.info({ count: expired.length }, 'orders expired');
      } catch (error) {
        logger.error({ err: error }, 'expiry sweep failed');
      }
      await sleep(5000);
    }
  };
  void expiryLoop();

  logger.info({ workers: workers.length }, 'worker started');
  const metricsServer = startMetricsServer(env.METRICS_PORT);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker draining');
    metricsServer.close();
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await container.shutdown();
    await stopTracing();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  void HANDLER_BY_QUEUE;
};

await main();
