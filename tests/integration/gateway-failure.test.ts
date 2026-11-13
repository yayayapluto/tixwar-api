import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createMockGateway, type MockGateway } from '../../src/mock-gateway/app.ts';
import {
  getHarness,
  type Harness,
  jsonRequest,
  resetDatabase,
  seedTier,
  seedUser,
  startTestPublisher,
  startTestWorkers,
  type TestPublisher,
  type TestWorkers,
  waitFor,
} from '../support/harness.ts';

let harness: Harness;
let gateway: MockGateway;
let gatewayServer: Server;
let workers: TestWorkers;
let publisher: TestPublisher;
let originalGatewayUrl: string;

beforeAll(async () => {
  harness = await getHarness();
  await resetDatabase(harness.container);

  gateway = createMockGateway();
  const started = await gateway.listen(0);
  gatewayServer = started.server;
  originalGatewayUrl = harness.container.env.GATEWAY_URL;
  harness.container.env.GATEWAY_URL = started.baseUrl;

  workers = await startTestWorkers(harness.container, { concurrency: 5 });
  publisher = await startTestPublisher(harness.container);
});

beforeEach(async () => {
  publisher.pause();
  gateway.state.failMode = false;
  gateway.state.latencyMs = 0;
  await resetDatabase(harness.container);
  for (const name of ['order', 'payment', 'notification', 'webhook'] as const) {
    await harness.container.queues.queues[name].obliterate({ force: true }).catch(() => undefined);
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 300);
  });
  publisher.resume();
});

afterAll(async () => {
  await publisher.stop();
  await workers.close();
  await new Promise<void>((resolve) => {
    gatewayServer.close(() => resolve());
  });
  harness.container.env.GATEWAY_URL = originalGatewayUrl;
  await harness.stop();
});

const createOrder = async (token: string, tierId: string, key: string): Promise<string> => {
  const created = await jsonRequest(harness.baseUrl, 'POST', '/v1/orders', {
    token,
    body: { tierId, quantity: 1 },
    headers: { 'idempotency-key': key },
  });
  expect(created.status).toBe(201);
  return (created.body as { data: { order: { id: string } } }).data.order.id;
};

describe('payment gateway failure and recovery', () => {
  it('returns 202 QUEUED while the gateway is down and reaches CONFIRMED after recovery', async () => {
    const tier = await seedTier(harness.container, { quota: 10, maxPerUser: 4 });
    const user = await seedUser(harness.container, 300);
    const orderId = await createOrder(user.accessToken, tier.tierId, 'gateway-down-order');

    publisher.pause();
    gateway.state.failMode = true;

    const pay = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/pay`, {
      token: user.accessToken,
      body: {},
      headers: { 'idempotency-key': 'gateway-down-pay' },
    });
    expect(pay.status).toBe(202);
    expect((pay.body as { data: { status: string } }).data.status).toBe('QUEUED');
    expect((pay.body as { data: { orderStatus: string } }).data.orderStatus).toBe('PAYMENT_QUEUED');

    const queuedOrder = await harness.container.collections.orders.findOne({ _id: orderId });
    expect(queuedOrder?.status).toBe('PAYMENT_QUEUED');

    const pendingOutbox = await harness.container.collections.outboxEvents
      .find({ userId: user.userId, type: 'payment.requested' })
      .toArray();
    expect(pendingOutbox).toHaveLength(1);
    expect(pendingOutbox[0]?.status).toBe('PENDING');

    publisher.resume();

    const failedPayment = await waitFor(async () => {
      const payment = await harness.container.collections.payments.findOne({ orderId });
      return payment?.status === 'FAILED' ? payment : null;
    }, 30_000);
    expect(failedPayment.attempt).toBe(1);
    expect(failedPayment.lastError).toContain('503');

    const stillQueued = await harness.container.collections.orders.findOne({ _id: orderId });
    expect(stillQueued?.status).toBe('PAYMENT_QUEUED');
    expect(await harness.container.collections.tickets.countDocuments({ orderId })).toBe(0);

    gateway.state.failMode = false;

    const confirmed = await waitFor(async () => {
      const order = await harness.container.collections.orders.findOne({ _id: orderId });
      return order?.status === 'CONFIRMED' ? order : null;
    }, 90_000);
    expect(confirmed.status).toBe('CONFIRMED');

    const tickets = await harness.container.collections.tickets.find({ orderId }).toArray();
    expect(tickets).toHaveLength(1);
    expect(gateway.state.chargeCount).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('never issues a ticket while the gateway keeps failing', async () => {
    const tier = await seedTier(harness.container, { quota: 10, maxPerUser: 4 });
    const user = await seedUser(harness.container, 301);
    const orderId = await createOrder(user.accessToken, tier.tierId, 'gateway-down-order-2');

    gateway.state.failMode = true;
    const pay = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/pay`, {
      token: user.accessToken,
      body: {},
      headers: { 'idempotency-key': 'gateway-down-pay-2' },
    });
    expect(pay.status).toBe(202);

    const firstFailure = await waitFor(async () => {
      const payment = await harness.container.collections.payments.findOne({ orderId });
      return payment?.status === 'FAILED' ? payment : null;
    }, 30_000);
    expect(firstFailure.attempt).toBe(1);

    const order = await harness.container.collections.orders.findOne({ _id: orderId });
    expect(['PAYMENT_QUEUED', 'PAYMENT_FAILED']).toContain(order!.status);
    expect(await harness.container.collections.tickets.countDocuments({ orderId })).toBe(0);

    gateway.state.failMode = false;
  }, 90_000);

  it('marks the order PAYMENT_FAILED and releases stock after exhausting attempts', async () => {
    const tier = await seedTier(harness.container, { quota: 10, maxPerUser: 4 });
    const user = await seedUser(harness.container, 302);
    const orderId = await createOrder(user.accessToken, tier.tierId, 'gateway-exhaust-order');

    gateway.state.failMode = true;
    const pay = await jsonRequest(harness.baseUrl, 'POST', `/v1/orders/${orderId}/pay`, {
      token: user.accessToken,
      body: {},
      headers: { 'idempotency-key': 'gateway-exhaust-pay' },
    });
    expect(pay.status).toBe(202);

    const exhausted = await waitFor(async () => {
      const order = await harness.container.collections.orders.findOne({ _id: orderId });
      return order?.status === 'PAYMENT_FAILED' ? order : null;
    }, 120_000);
    expect(exhausted.paymentAttempts).toBe(harness.container.env.MAX_PAYMENT_ATTEMPTS);

    const payment = await harness.container.collections.payments
      .find({ orderId })
      .sort({ attempt: 1 })
      .toArray();
    expect(payment.length).toBe(harness.container.env.MAX_PAYMENT_ATTEMPTS);
    expect(payment.every((entry) => entry.status === 'FAILED')).toBe(true);

    expect(await harness.container.collections.tickets.countDocuments({ orderId })).toBe(0);

    gateway.state.failMode = false;
  }, 180_000);
});
