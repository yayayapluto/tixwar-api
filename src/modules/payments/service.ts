import type { MongoClient } from 'mongodb';
import type { Env } from '../../config/env.ts';
import { writeOutbox } from '../../events/outbox.ts';
import { runInTransaction } from '../../infra/db/client.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { OrderDoc, PaymentDoc } from '../../infra/db/types.ts';
import { metrics } from '../../infra/metrics/registry.ts';
import type { PubSub } from '../../infra/redis/pubsub.ts';
import { newPaymentId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { conflict, invalidStateTransition, notFound } from '../../shared/problem.ts';
import { isTerminal } from '../orders/state.ts';

const logger = createLogger('payments');

export interface PaymentServiceDeps {
  env: Env;
  collections: Collections;
  client: MongoClient;
  pubsub: PubSub;
}

export interface PayResult {
  status: 'ACCEPTED' | 'QUEUED';
  payment: {
    id: string;
    orderId: string;
    status: PaymentDoc['status'];
    attempt: number;
  };
  orderStatus: OrderDoc['status'];
}

export class PaymentService {
  private readonly deps: PaymentServiceDeps;

  constructor(deps: PaymentServiceDeps) {
    this.deps = deps;
  }

  async requestPayment(input: {
    orderId: string;
    userId: string;
    idempotencyKey: string;
    requestId: string;
  }): Promise<PayResult> {
    const order = await this.deps.collections.orders.findOne({
      _id: input.orderId,
      userId: input.userId,
      deletedAt: null,
    });
    if (!order) throw notFound('Order not found');

    if (isTerminal(order.status)) {
      if (order.status === 'PAID' || order.status === 'CONFIRMED') {
        const existing = await this.deps.collections.payments.findOne({
          userId: order.userId,
          orderId: order._id,
          status: 'SUCCEEDED',
        });
        if (existing) {
          return {
            status: 'ACCEPTED',
            payment: {
              id: existing._id,
              orderId: existing.orderId,
              status: existing.status,
              attempt: existing.attempt,
            },
            orderStatus: order.status,
          };
        }
      }
      throw invalidStateTransition(`Order is already ${order.status}`);
    }

    if (order.expiresAt.getTime() <= Date.now()) {
      throw conflict('ORDER_EXPIRED', 'Order Expired', 'Order has expired and cannot be paid');
    }

    if (order.paymentAttempts >= this.deps.env.MAX_PAYMENT_ATTEMPTS) {
      throw conflict(
        'INVALID_STATE_TRANSITION',
        'Invalid State Transition',
        'Maximum payment attempts reached',
      );
    }

    const attempt = order.paymentAttempts + 1;
    const payment: PaymentDoc = {
      _id: newPaymentId(),
      orderId: order._id,
      userId: order.userId,
      status: 'QUEUED',
      attempt,
      providerRef: null,
      idempotencyKey: input.idempotencyKey,
      amount: order.total,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const updatedOrder = await runInTransaction(this.deps.client, async (session) => {
      await this.deps.collections.payments.insertOne(payment, { session });
      const updated = await this.deps.collections.orders.findOneAndUpdate(
        {
          _id: order._id,
          userId: order.userId,
          status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED'] },
        },
        {
          $set: {
            status: 'PAYMENT_QUEUED',
            updatedAt: new Date(),
            paymentAttempts: attempt,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!updated) return null;
      await writeOutbox(
        this.deps.collections,
        {
          userId: order.userId,
          aggregateType: 'payment',
          aggregateId: payment._id,
          type: 'payment.requested',
          payload: {
            paymentId: payment._id,
            orderId: order._id,
            amount: payment.amount,
            attempt,
            idempotencyKey: input.idempotencyKey,
          },
          requestId: input.requestId,
        },
        session,
      );
      return updated;
    });

    if (!updatedOrder) {
      throw invalidStateTransition('Order status changed concurrently');
    }

    metrics.ordersTotal.inc({ status: 'PAYMENT_QUEUED' });
    await this.deps.pubsub.publish(`order:${order._id}`, {
      type: 'order.status',
      status: 'PAYMENT_QUEUED',
      paymentId: payment._id,
    });

    return {
      status: 'QUEUED',
      payment: {
        id: payment._id,
        orderId: payment.orderId,
        status: payment.status,
        attempt: payment.attempt,
      },
      orderStatus: updatedOrder.status,
    };
  }

  async applySuccess(input: {
    paymentId: string;
    userId: string;
    providerRef: string;
    requestId: string;
  }): Promise<{ orderId: string; orderStatus: OrderDoc['status'] }> {
    const payment = await this.deps.collections.payments.findOne({
      _id: input.paymentId,
      userId: input.userId,
    });
    if (!payment) throw notFound('Payment not found');

    const result = await runInTransaction(this.deps.client, async (session) => {
      const updatedPayment = await this.deps.collections.payments.findOneAndUpdate(
        { _id: payment._id, userId: payment.userId, status: { $in: ['QUEUED', 'FAILED'] } },
        {
          $set: {
            status: 'SUCCEEDED',
            providerRef: input.providerRef,
            lastError: null,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after', session },
      );
      if (!updatedPayment) return null;

      const order = await this.deps.collections.orders.findOneAndUpdate(
        { _id: payment.orderId, userId: payment.userId, status: 'PAYMENT_QUEUED' },
        { $set: { status: 'PAID', updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!order) return null;

      await writeOutbox(
        this.deps.collections,
        {
          userId: order.userId,
          aggregateType: 'order',
          aggregateId: order._id,
          type: 'order.paid',
          payload: { orderId: order._id, paymentId: payment._id, amount: payment.amount },
          requestId: input.requestId,
        },
        session,
      );
      return order;
    });

    if (!result) {
      const current = await this.deps.collections.orders.findOne({
        _id: payment.orderId,
        userId: payment.userId,
      });
      if (!current) throw notFound('Order not found');
      if (current.status === 'EXPIRED') {
        logger.warn(
          { orderId: current._id, paymentId: payment._id, requestId: input.requestId },
          'late payment after expiry; requires manual compensation, no ticket issued',
        );
        throw conflict(
          'ORDER_EXPIRED',
          'Order Expired',
          'Payment succeeded after expiry; flagged for compensation without issuing a ticket',
        );
      }
      return { orderId: current._id, orderStatus: current.status };
    }

    metrics.ordersTotal.inc({ status: 'PAID' });
    await this.deps.pubsub.publish(`order:${result._id}`, { type: 'order.status', status: 'PAID' });
    return { orderId: result._id, orderStatus: result.status };
  }

  async applyFailure(input: {
    paymentId: string;
    userId: string;
    reason: string;
    requestId: string;
  }): Promise<{
    orderId: string;
    orderStatus: OrderDoc['status'];
    exhausted: boolean;
    nextPaymentId: string | null;
  }> {
    const payment = await this.deps.collections.payments.findOne({
      _id: input.paymentId,
      userId: input.userId,
    });
    if (!payment) throw notFound('Payment not found');

    const exhausted = payment.attempt >= this.deps.env.MAX_PAYMENT_ATTEMPTS;

    const result = await runInTransaction(this.deps.client, async (session) => {
      const updatedPayment = await this.deps.collections.payments.findOneAndUpdate(
        { _id: payment._id, userId: payment.userId, status: 'QUEUED' },
        {
          $set: { status: 'FAILED', lastError: input.reason.slice(0, 300), updatedAt: new Date() },
        },
        { returnDocument: 'after', session },
      );
      if (!updatedPayment) return null;

      const nextStatus: OrderDoc['status'] = exhausted ? 'PAYMENT_FAILED' : 'PAYMENT_QUEUED';
      const order = await this.deps.collections.orders.findOneAndUpdate(
        {
          _id: payment.orderId,
          userId: payment.userId,
          status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED'] },
        },
        {
          $set: {
            status: nextStatus,
            updatedAt: new Date(),
            ...(exhausted ? { reservationReleased: true } : {}),
          },
        },
        { returnDocument: 'after', session },
      );
      if (!order) return null;

      let nextPaymentId: string | null = null;
      if (!exhausted) {
        const nextPayment: PaymentDoc = {
          _id: newPaymentId(),
          orderId: order._id,
          userId: order.userId,
          status: 'QUEUED',
          attempt: payment.attempt + 1,
          providerRef: null,
          idempotencyKey: payment.idempotencyKey,
          amount: payment.amount,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await this.deps.collections.payments.insertOne(nextPayment, { session });
        await this.deps.collections.orders.updateOne(
          { _id: order._id, userId: order.userId },
          { $set: { paymentAttempts: nextPayment.attempt, updatedAt: new Date() } },
          { session },
        );
        nextPaymentId = nextPayment._id;
      }

      await writeOutbox(
        this.deps.collections,
        {
          userId: order.userId,
          aggregateType: 'order',
          aggregateId: order._id,
          type: exhausted ? 'payment.failed' : 'payment.requested',
          payload: {
            orderId: order._id,
            paymentId: nextPaymentId ?? payment._id,
            attempt: exhausted ? payment.attempt : payment.attempt + 1,
            reason: input.reason.slice(0, 300),
            retryable: !exhausted,
          },
          requestId: input.requestId,
        },
        session,
      );
      return { order, nextPaymentId };
    });

    if (!result) {
      const current = await this.deps.collections.orders.findOne({
        _id: payment.orderId,
        userId: payment.userId,
      });
      if (!current) throw notFound('Order not found');
      return {
        orderId: current._id,
        orderStatus: current.status,
        exhausted,
        nextPaymentId: null,
      };
    }

    if (exhausted) metrics.ordersTotal.inc({ status: 'PAYMENT_FAILED' });
    await this.deps.pubsub.publish(`order:${result.order._id}`, {
      type: 'order.status',
      status: result.order.status,
      attempt: payment.attempt,
    });
    return {
      orderId: result.order._id,
      orderStatus: result.order.status,
      exhausted,
      nextPaymentId: result.nextPaymentId,
    };
  }
}
