import { randomUUID } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import type { Env } from '../config/env.ts';
import type { PaymentGatewayClient } from '../infra/breaker/gateway-client.ts';
import type { BreakerRegistry } from '../infra/breaker/registry.ts';
import { runInTransaction } from '../infra/db/client.ts';
import type { Collections } from '../infra/db/collections.ts';
import type { EventJobData } from '../infra/queue/queues.ts';
import type { PubSub } from '../infra/redis/pubsub.ts';
import { audit } from '../modules/audit/service.ts';
import type { NotificationService } from '../modules/notifications/service.ts';
import type { OrderService } from '../modules/orders/service.ts';
import type { PaymentService } from '../modules/payments/service.ts';
import type { TicketService } from '../modules/tickets/service.ts';
import type { WebhookService } from '../modules/webhooks/service.ts';
import { createLogger } from '../shared/logger.ts';

const logger = createLogger('worker-handlers');

export interface HandlerDeps {
  env: Env;
  collections: Collections;
  client: MongoClient;
  orders: OrderService;
  payments: PaymentService;
  tickets: TicketService;
  notifications: NotificationService;
  webhooks: WebhookService;
  gateway: PaymentGatewayClient;
  breakers: BreakerRegistry;
  pubsub: PubSub;
}

export type Handler = (job: EventJobData) => Promise<void>;

const claimProcessed = async (
  collections: Collections,
  client: MongoClient,
  input: { userId: string; eventId: string; consumer: string },
): Promise<boolean> => {
  try {
    await runInTransaction(client, async (session) => {
      await collections.processedEvents.insertOne(
        {
          _id: `pce_${randomUUID()}`,
          userId: input.userId,
          eventId: input.eventId,
          consumer: input.consumer,
          processedAt: new Date(),
        },
        { session },
      );
    });
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code: number }).code
        : 0;
    if (code === 11000) {
      logger.debug({ eventId: input.eventId, consumer: input.consumer }, 'duplicate event skipped');
      return false;
    }
    throw error;
  }
};

export const buildHandlers = (deps: HandlerDeps): Record<string, Handler> => {
  const handleOrderCreated: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: 'order.created',
    });
    if (!fresh) return;

    await audit(deps.collections, {
      userId: job.userId,
      action: 'order.created',
      entity: 'orders',
      entityId: job.aggregateId,
      diff: { requestId: job.requestId },
      requestId: job.requestId,
    });
    await deps.notifications.sendOrderCreated({
      userId: job.userId,
      orderId: job.aggregateId,
      requestId: job.requestId,
    });
  };

  const handlePaymentRequested: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: 'payment.requested',
    });
    if (!fresh) return;

    const paymentId = String(job.data.paymentId ?? '');
    const orderId = String(job.data.orderId ?? '');
    const amount = Number(job.data.amount ?? 0);
    const attempt = Number(job.data.attempt ?? 1);
    const idempotencyKey = String(job.data.idempotencyKey ?? `idem_${paymentId}`);

    const payment = await deps.collections.payments.findOne({
      _id: paymentId,
      userId: job.userId,
    });
    if (!payment) {
      logger.warn({ paymentId, orderId }, 'payment record missing; skipping charge');
      return;
    }
    if (payment.status === 'SUCCEEDED') {
      logger.debug({ paymentId }, 'payment already succeeded; skipping duplicate charge');
      return;
    }

    try {
      const charge = await deps.gateway.charge({
        orderId,
        paymentId,
        amount,
        attempt,
        idempotencyKey,
      });
      if (charge.status === 'SUCCEEDED') {
        await deps.payments.applySuccess({
          paymentId,
          userId: job.userId,
          providerRef: charge.providerRef,
          requestId: job.requestId,
        });
        return;
      }
      await deps.payments.applyFailure({
        paymentId,
        userId: job.userId,
        reason: charge.reason ?? 'gateway returned failure',
        requestId: job.requestId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'gateway error';
      const outcome = await deps.payments.applyFailure({
        paymentId,
        userId: job.userId,
        reason: message,
        requestId: job.requestId,
      });
      await deps.pubsub.publish(`order:${outcome.orderId}`, {
        type: 'order.status',
        status: outcome.orderStatus,
        retryable: !outcome.exhausted,
      });
      if (outcome.exhausted) {
        logger.warn({ orderId, paymentId }, 'payment attempts exhausted');
        return;
      }
      logger.info(
        { orderId, paymentId, attempt, requestId: job.requestId, reason: message },
        'payment queued for retry via outbox backoff',
      );
    }
  };

  const handleOrderPaid: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: 'order.paid',
    });
    if (!fresh) return;

    const result = await deps.tickets.issueForOrder({
      orderId: job.aggregateId,
      userId: job.userId,
      requestId: job.requestId,
    });
    if (!result) {
      logger.warn({ orderId: job.aggregateId }, 'ticket issuance skipped; order not payable state');
    }
  };

  const handleOrderConfirmed: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: 'order.confirmed',
    });
    if (!fresh) return;

    await deps.notifications.sendTicketIssued({
      userId: job.userId,
      orderId: job.aggregateId,
      ticketCode: String(job.data.code ?? ''),
      requestId: job.requestId,
    });
    await deps.webhooks.deliverForUser({
      userId: job.userId,
      eventType: 'order.confirmed',
      payload: { orderId: job.aggregateId, ticketId: job.data.ticketId ?? null },
      requestId: job.requestId,
    });
  };

  const handleOrderClosed: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: job.type,
    });
    if (!fresh) return;

    await audit(deps.collections, {
      userId: job.userId,
      action: job.type,
      entity: 'orders',
      entityId: job.aggregateId,
      diff: { reason: job.data.reason ?? null },
      requestId: job.requestId,
    });
    await deps.webhooks.deliverForUser({
      userId: job.userId,
      eventType: job.type,
      payload: { orderId: job.aggregateId, reason: job.data.reason ?? null },
      requestId: job.requestId,
    });
  };

  const handlePaymentFailed: Handler = async (job) => {
    const fresh = await claimProcessed(deps.collections, deps.client, {
      userId: job.userId,
      eventId: job.id,
      consumer: 'payment.failed',
    });
    if (!fresh) return;

    await deps.notifications.sendPaymentFailed({
      userId: job.userId,
      orderId: job.aggregateId,
      requestId: job.requestId,
    });
  };

  return {
    'order.created': handleOrderCreated,
    'payment.requested': handlePaymentRequested,
    'order.paid': handleOrderPaid,
    'order.confirmed': handleOrderConfirmed,
    'order.expired': handleOrderClosed,
    'order.cancelled': handleOrderClosed,
    'payment.failed': handlePaymentFailed,
    'payment.succeeded': async (job) => {
      await claimProcessed(deps.collections, deps.client, {
        userId: job.userId,
        eventId: job.id,
        consumer: 'payment.succeeded',
      });
    },
    'stock.released': async (job) => {
      await claimProcessed(deps.collections, deps.client, {
        userId: job.userId,
        eventId: job.id,
        consumer: 'stock.released',
      });
    },
    'notification.email': async (job) => {
      const fresh = await claimProcessed(deps.collections, deps.client, {
        userId: job.userId,
        eventId: job.id,
        consumer: 'notification.email',
      });
      if (!fresh) return;
      await deps.notifications.sendRaw({
        userId: job.userId,
        subject: String(job.data.subject ?? 'TixWar notification'),
        body: String(job.data.body ?? ''),
        requestId: job.requestId,
      });
    },
    'webhook.deliver': async (job) => {
      const fresh = await claimProcessed(deps.collections, deps.client, {
        userId: job.userId,
        eventId: job.id,
        consumer: 'webhook.deliver',
      });
      if (!fresh) return;
      await deps.webhooks.deliverForUser({
        userId: job.userId,
        eventType: String(job.data.eventType ?? 'order.confirmed'),
        payload: (job.data.payload as Record<string, unknown>) ?? {},
        requestId: job.requestId,
      });
    },
  };
};
