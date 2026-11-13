import type { Env } from '../config/env.ts';
import type { Collections } from '../infra/db/collections.ts';
import type { OutboxEventDoc } from '../infra/db/types.ts';
import { metrics } from '../infra/metrics/registry.ts';
import type { QueueContext, QueueName } from '../infra/queue/queues.ts';
import { QUEUE_BY_EVENT_TYPE } from '../infra/queue/queues.ts';
import { createLogger } from '../shared/logger.ts';
import { deterministicJobId, toEnvelope } from './outbox.ts';

const logger = createLogger('outbox-publisher');

export interface PublisherDeps {
  env: Env;
  collections: Collections;
  queues: QueueContext;
}

export interface PublishResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const claimBatch = async (collections: Collections, env: Env): Promise<OutboxEventDoc[]> => {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + env.OUTBOX_LEASE_MS);
  const candidates = await collections.outboxEvents
    .find({
      $or: [{ status: 'PENDING' }, { status: 'PUBLISHING', leaseUntil: { $lt: now } }],
    })
    .sort({ createdAt: 1 })
    .limit(env.OUTBOX_BATCH_SIZE)
    .toArray();

  const claimed: OutboxEventDoc[] = [];
  for (const candidate of candidates) {
    const result = await collections.outboxEvents.findOneAndUpdate(
      {
        _id: candidate._id,
        $or: [
          { status: 'PENDING', leaseUntil: null },
          { status: 'PENDING', leaseUntil: { $lte: now } },
          { status: 'PUBLISHING', leaseUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'PUBLISHING', leaseUntil, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (result) claimed.push(result);
  }
  return claimed;
};

export const enqueueOutboxEvent = async (
  queues: QueueContext,
  doc: OutboxEventDoc,
): Promise<QueueName> => {
  const queueName = QUEUE_BY_EVENT_TYPE[doc.type];
  if (!queueName) throw new Error(`no queue mapped for event type ${doc.type}`);
  const queue = queues.queues[queueName];
  const envelope = toEnvelope(doc);
  await queue.add(doc.type, { ...envelope }, { jobId: deterministicJobId(doc._id) });
  return queueName;
};

export const publishBatch = async (deps: PublisherDeps): Promise<PublishResult> => {
  const claimed = await claimBatch(deps.collections, deps.env);
  const result: PublishResult = {
    claimed: claimed.length,
    published: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const doc of claimed) {
    try {
      const queueName = await enqueueOutboxEvent(deps.queues, doc);
      await deps.collections.outboxEvents.updateOne(
        { _id: doc._id, userId: doc.userId },
        {
          $set: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            updatedAt: new Date(),
            leaseUntil: null,
          },
          $inc: { attempts: 1 },
        },
      );
      metrics.outboxPublishTotal.inc({ type: doc.type, result: 'published' });
      result.published += 1;
      logger.debug(
        { eventId: doc._id, type: doc.type, queue: queueName },
        'outbox event published',
      );
    } catch (error) {
      const attempts = doc.attempts + 1;
      const exhausted = attempts >= deps.env.OUTBOX_MAX_ATTEMPTS;
      const backoffMs = Math.min(30000, 500 * 2 ** attempts) + Math.floor(Math.random() * 250);
      const retryAt = new Date(Date.now() + backoffMs);
      await deps.collections.outboxEvents.updateOne(
        { _id: doc._id, userId: doc.userId },
        {
          $set: {
            status: exhausted ? 'DEAD_LETTER' : 'PENDING',
            attempts,
            lastError: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
            updatedAt: new Date(),
            leaseUntil: exhausted ? null : retryAt,
          },
        },
      );
      metrics.outboxPublishTotal.inc({
        type: doc.type,
        result: exhausted ? 'dead_letter' : 'failed',
      });
      if (exhausted) result.deadLettered += 1;
      else result.failed += 1;
      logger.error({ err: error, eventId: doc._id, attempts, exhausted }, 'outbox publish failed');
    }
  }

  return result;
};

export const countPending = async (collections: Collections): Promise<number> =>
  collections.outboxEvents.countDocuments({ status: { $in: ['PENDING', 'PUBLISHING'] } });

export const runPublisherLoop = async (deps: PublisherDeps, signal: AbortSignal): Promise<void> => {
  while (!signal.aborted) {
    try {
      const result = await publishBatch(deps);
      const pending = await countPending(deps.collections);
      metrics.outboxPending.set(pending);
      if (result.claimed === 0) await sleep(deps.env.OUTBOX_POLL_INTERVAL_MS);
    } catch (error) {
      logger.error({ err: error }, 'publisher loop error');
      await sleep(1000);
    }
  }
  logger.info('outbox publisher stopped');
};

export const replayDeadLetters = async (
  collections: Collections,
  limit = 100,
): Promise<{ replayed: number }> => {
  const docs = await collections.outboxEvents
    .find({ status: 'DEAD_LETTER' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
  let replayed = 0;
  for (const doc of docs) {
    const result = await collections.outboxEvents.updateOne(
      { _id: doc._id, status: 'DEAD_LETTER' },
      { $set: { status: 'PENDING', attempts: 0, lastError: null, updatedAt: new Date() } },
    );
    replayed += result.modifiedCount;
  }
  return { replayed };
};
