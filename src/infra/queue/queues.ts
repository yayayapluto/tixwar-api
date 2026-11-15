import { Queue, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('queue');

export const QUEUE_NAMES = {
  order: 'order',
  payment: 'payment',
  notification: 'notification',
  webhook: 'webhook',
  expiry: 'expiry',
  dlq: 'dlq',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_BY_EVENT_TYPE: Record<string, QueueName> = {
  'order.created': QUEUE_NAMES.order,
  'order.paid': QUEUE_NAMES.order,
  'order.confirmed': QUEUE_NAMES.notification,
  'order.expired': QUEUE_NAMES.notification,
  'order.cancelled': QUEUE_NAMES.notification,
  'payment.requested': QUEUE_NAMES.payment,
  'payment.succeeded': QUEUE_NAMES.payment,
  'payment.failed': QUEUE_NAMES.payment,
  'stock.released': QUEUE_NAMES.order,
  'notification.email': QUEUE_NAMES.notification,
  'webhook.deliver': QUEUE_NAMES.webhook,
};

export interface EventJobData {
  id: string;
  type: string;
  userId: string;
  aggregateId: string;
  requestId: string;
  occurredAt: string;
  schemaVersion: number;
  data: Record<string, unknown>;
}

export interface QueueContext {
  queues: Record<QueueName, Queue<EventJobData>>;
  connection: Redis;
  close: () => Promise<void>;
}

export const createQueues = (env: Env, connection: Redis): QueueContext => {
  const queues = {} as Record<QueueName, Queue<EventJobData>>;
  for (const name of Object.values(QUEUE_NAMES)) {
    queues[name] = new Queue<EventJobData>(`${env.QUEUE_PREFIX}-${name}`, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 5000 },
      },
    });
  }
  logger.debug({ queues: Object.keys(queues) }, 'queues created');
  return {
    queues,
    connection,
    close: async () => {
      await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
    },
  };
};

export const workerOptions = (
  env: Env,
  queueName: QueueName,
  connection: Redis,
): WorkerOptions => ({
  connection,
  concurrency:
    queueName === QUEUE_NAMES.order
      ? env.WORKER_CONCURRENCY_ORDER
      : queueName === QUEUE_NAMES.payment
        ? env.WORKER_CONCURRENCY_PAYMENT
        : queueName === QUEUE_NAMES.notification
          ? env.WORKER_CONCURRENCY_NOTIFICATION
          : queueName === QUEUE_NAMES.webhook
            ? env.WORKER_CONCURRENCY_WEBHOOK
            : env.WORKER_CONCURRENCY_EXPIRY,
});

export const queueDepthFor = async (queue: Queue<EventJobData>): Promise<number> => {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
  return (
    (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0)
  );
};
