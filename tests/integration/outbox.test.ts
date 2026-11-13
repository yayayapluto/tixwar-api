import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { buildHandlers } from '../../src/events/handlers.ts';
import { buildOutboxDoc, deterministicJobId, toEnvelope } from '../../src/events/outbox.ts';
import { claimBatch, publishBatch, replayDeadLetters } from '../../src/events/publisher.ts';
import type { EventJobData } from '../../src/infra/queue/queues.ts';
import { QUEUE_BY_EVENT_TYPE } from '../../src/infra/queue/queues.ts';
import { getHarness, type Harness, resetDatabase, seedTier, seedUser } from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
});

beforeEach(async () => {
  await resetDatabase(harness.container);
  await harness.container.queues.queues.order.obliterate({ force: true }).catch(() => undefined);
  await harness.container.queues.queues.payment.obliterate({ force: true }).catch(() => undefined);
  await harness.container.queues.queues.notification
    .obliterate({ force: true })
    .catch(() => undefined);
});

afterAll(async () => {
  await harness.stop();
});

const publisherDeps = () => ({
  env: harness.container.env,
  collections: harness.container.collections,
  queues: harness.container.queues,
});

describe('outbox publisher', () => {
  it('claims pending events with a lease before publishing', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 200);
    const doc = buildOutboxDoc({
      userId: user.userId,
      aggregateType: 'order',
      aggregateId: 'ord_publisher_test_1',
      type: 'order.created',
      payload: { orderId: 'ord_publisher_test_1', tierId: tier.tierId },
      requestId: 'req-publisher-1',
    });
    await harness.container.collections.outboxEvents.insertOne(doc);

    const claimed = await claimBatch(harness.container.collections, harness.container.env);
    expect(claimed.map((entry) => entry._id)).toContain(doc._id);
    const publishing = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(publishing?.status).toBe('PUBLISHING');
    expect(publishing?.leaseUntil).toBeInstanceOf(Date);

    const secondClaim = await claimBatch(harness.container.collections, harness.container.env);
    expect(secondClaim.map((entry) => entry._id)).not.toContain(doc._id);
  }, 30_000);

  it('enqueues claimed events and marks them PUBLISHED', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 204);
    const doc = buildOutboxDoc({
      userId: user.userId,
      aggregateType: 'order',
      aggregateId: 'ord_publish_test_2',
      type: 'order.created',
      payload: { orderId: 'ord_publish_test_2', tierId: tier.tierId },
      requestId: 'req-publish-2',
    });
    await harness.container.collections.outboxEvents.insertOne(doc);

    const result = await publishBatch(publisherDeps());
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const published = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(published?.status).toBe('PUBLISHED');
    expect(published?.publishedAt).toBeInstanceOf(Date);
    expect(published?.attempts).toBe(1);

    const job = await harness.container.queues.queues.order.getJob(deterministicJobId(doc._id));
    expect(job).toBeDefined();
    expect(job?.data.aggregateId).toBe('ord_publish_test_2');
  }, 30_000);

  it('uses a deterministic job id so duplicate enqueue cannot create a second job', async () => {
    const doc = buildOutboxDoc({
      userId: 'usr_duplicate_job',
      aggregateType: 'order',
      aggregateId: 'ord_duplicate_job',
      type: 'order.created',
      payload: {},
      requestId: 'req-duplicate-job',
    });
    const queueName = QUEUE_BY_EVENT_TYPE['order.created']!;
    const queue = harness.container.queues.queues[queueName];
    const jobId = deterministicJobId(doc._id);
    const envelope = toEnvelope(doc);

    await queue.add('order.created', { ...envelope }, { jobId });
    await queue.add('order.created', { ...envelope }, { jobId });

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(jobId);
    await job?.remove();
  }, 30_000);

  it('survives a publisher restart without losing events', async () => {
    const user = await seedUser(harness.container, 201);
    const doc = buildOutboxDoc({
      userId: user.userId,
      aggregateType: 'order',
      aggregateId: 'ord_restart_test',
      type: 'order.created',
      payload: { orderId: 'ord_restart_test' },
      requestId: 'req-restart',
    });
    await harness.container.collections.outboxEvents.insertOne(doc);

    await claimBatch(harness.container.collections, harness.container.env);
    await harness.container.collections.outboxEvents.updateOne(
      { _id: doc._id },
      { $set: { status: 'PUBLISHING', leaseUntil: new Date(Date.now() + 60_000) } },
    );

    const result = await publishBatch(publisherDeps());
    expect(result.published).toBe(0);

    await harness.container.collections.outboxEvents.updateOne(
      { _id: doc._id },
      { $set: { leaseUntil: new Date(Date.now() - 1_000) } },
    );

    const recovered = await publishBatch(publisherDeps());
    expect(recovered.published).toBe(1);
    const published = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(published?.status).toBe('PUBLISHED');
  }, 30_000);

  it('retries with backoff and eventually dead-letters an unpublishable event', async () => {
    const user = await seedUser(harness.container, 202);
    const doc = buildOutboxDoc({
      userId: user.userId,
      aggregateType: 'order',
      aggregateId: 'ord_dlq_test',
      type: 'unknown.event.type',
      payload: {},
      requestId: 'req-dlq',
    });
    await harness.container.collections.outboxEvents.insertOne(doc);

    const maxAttempts = harness.container.env.OUTBOX_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await harness.container.collections.outboxEvents.updateOne(
        { _id: doc._id },
        { $set: { leaseUntil: new Date(Date.now() - 1_000) } },
      );
      await publishBatch(publisherDeps());
    }

    const dead = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(dead?.status).toBe('DEAD_LETTER');
    expect(dead?.attempts).toBe(maxAttempts);
    expect(dead?.lastError).toContain('no queue mapped');

    const replayed = await replayDeadLetters(harness.container.collections, 100);
    expect(replayed.replayed).toBeGreaterThanOrEqual(1);
    const reset = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(reset?.status).toBe('PENDING');
    expect(reset?.attempts).toBe(0);
  }, 60_000);

  it('applies a backoff lease after a failed publish attempt', async () => {
    const user = await seedUser(harness.container, 203);
    const doc = buildOutboxDoc({
      userId: user.userId,
      aggregateType: 'order',
      aggregateId: 'ord_backoff_test',
      type: 'unknown.event.type',
      payload: {},
      requestId: 'req-backoff',
    });
    await harness.container.collections.outboxEvents.insertOne(doc);

    await publishBatch(publisherDeps());
    const failed = await harness.container.collections.outboxEvents.findOne({ _id: doc._id });
    expect(failed?.status).toBe('PENDING');
    expect(failed?.attempts).toBe(1);
    expect(failed?.leaseUntil).toBeInstanceOf(Date);
    expect(failed!.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  }, 30_000);
});

describe('idempotent consumers', () => {
  it('processes the same event only once per consumer', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 210);
    const handlers = buildHandlers({
      env: harness.container.env,
      collections: harness.container.collections,
      client: harness.container.client,
      orders: harness.container.orders,
      payments: harness.container.payments,
      tickets: harness.container.tickets,
      notifications: harness.container.notifications,
      webhooks: harness.container.webhooks,
      gateway: harness.container.gateway,
      breakers: harness.container.breakers,
      pubsub: harness.container.pubsub,
    });

    const order = await harness.container.orders.create({
      userId: user.userId,
      tierId: tier.tierId,
      quantity: 1,
      requestId: 'req-dedupe',
    });

    const job: EventJobData = {
      id: 'obx_dedupe_event',
      type: 'order.created',
      userId: user.userId,
      aggregateId: order.id,
      requestId: 'req-dedupe',
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
      data: { orderId: order.id },
    };

    await handlers['order.created']!(job);
    await handlers['order.created']!(job);
    await handlers['order.created']!(job);

    const processed = await harness.container.collections.processedEvents
      .find({ userId: user.userId, eventId: 'obx_dedupe_event', consumer: 'order.created' })
      .toArray();
    expect(processed).toHaveLength(1);

    const audits = await harness.container.collections.auditLogs
      .find({ entityId: order.id, action: 'order.created' })
      .toArray();
    expect(audits).toHaveLength(1);
  }, 30_000);

  it('issues exactly one ticket for repeated order.paid deliveries', async () => {
    const tier = await seedTier(harness.container, { quota: 5 });
    const user = await seedUser(harness.container, 211);
    const handlers = buildHandlers({
      env: harness.container.env,
      collections: harness.container.collections,
      client: harness.container.client,
      orders: harness.container.orders,
      payments: harness.container.payments,
      tickets: harness.container.tickets,
      notifications: harness.container.notifications,
      webhooks: harness.container.webhooks,
      gateway: harness.container.gateway,
      breakers: harness.container.breakers,
      pubsub: harness.container.pubsub,
    });

    const order = await harness.container.orders.create({
      userId: user.userId,
      tierId: tier.tierId,
      quantity: 1,
      requestId: 'req-ticket-idempotent',
    });
    const payment = await harness.container.payments.requestPayment({
      orderId: order.id,
      userId: user.userId,
      idempotencyKey: 'ticket-idempotent-pay',
      requestId: 'req-ticket-idempotent',
    });
    await harness.container.payments.applySuccess({
      paymentId: payment.payment.id,
      userId: user.userId,
      providerRef: 'pg_test',
      requestId: 'req-ticket-idempotent',
    });

    const job: EventJobData = {
      id: 'obx_ticket_event',
      type: 'order.paid',
      userId: user.userId,
      aggregateId: order.id,
      requestId: 'req-ticket-idempotent',
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
      data: { orderId: order.id },
    };

    await handlers['order.paid']!(job);
    await handlers['order.paid']!(job);

    const tickets = await harness.container.collections.tickets
      .find({ orderId: order.id })
      .toArray();
    expect(tickets).toHaveLength(1);

    const confirmed = await harness.container.collections.orders.findOne({ _id: order.id });
    expect(confirmed?.status).toBe('CONFIRMED');
  }, 60_000);
});
