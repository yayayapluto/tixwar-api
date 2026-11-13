import type { MongoClient } from 'mongodb';
import type { Env } from '../../config/env.ts';
import { writeOutbox } from '../../events/outbox.ts';
import { runInTransaction } from '../../infra/db/client.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { OrderDoc, OrderStatus } from '../../infra/db/types.ts';
import { metrics } from '../../infra/metrics/registry.ts';
import type { CacheStore } from '../../infra/redis/cache.ts';
import type { PubSub } from '../../infra/redis/pubsub.ts';
import type { StockGate } from '../../infra/redis/stock.ts';
import { decodeCursor, encodeCursor } from '../../shared/cursor.ts';
import { newOrderId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import {
  badRequest,
  conflict,
  dependencyUnavailable,
  forbidden,
  limitExceeded,
  notFound,
  soldOut,
} from '../../shared/problem.ts';
import { assertTransition, isTerminal } from './state.ts';

const logger = createLogger('orders');

export interface OrderServiceDeps {
  env: Env;
  collections: Collections;
  client: MongoClient;
  stock: StockGate;
  cache: CacheStore;
  pubsub: PubSub;
}

export interface CreateOrderInput {
  userId: string;
  tierId: string;
  quantity: number;
  requestId: string;
}

export interface OrderView {
  id: string;
  userId: string;
  eventId: string;
  tierId: string;
  quantity: number;
  unitPrice: number;
  total: number;
  status: OrderStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  paymentAttempts: number;
}

export const serializeOrder = (doc: OrderDoc): OrderView => ({
  id: doc._id,
  userId: doc.userId,
  eventId: doc.eventId,
  tierId: doc.tierId,
  quantity: doc.quantity,
  unitPrice: doc.unitPrice,
  total: doc.total,
  status: doc.status,
  expiresAt: doc.expiresAt.toISOString(),
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
  paymentAttempts: doc.paymentAttempts,
});

export class OrderService {
  private readonly deps: OrderServiceDeps;

  constructor(deps: OrderServiceDeps) {
    this.deps = deps;
  }

  async create(input: CreateOrderInput): Promise<OrderView> {
    const tier = await this.deps.collections.ticketTiers.findOne({ _id: input.tierId });
    if (!tier) throw notFound('Ticket tier not found');

    const event = await this.deps.collections.events.findOne({
      _id: tier.eventId,
      deletedAt: null,
    });
    if (!event) throw notFound('Event not found');

    const now = new Date();
    if (now.getTime() < tier.saleStartsAt.getTime()) {
      throw forbidden('Sale has not started for this tier');
    }
    if (tier.saleEndsAt.getTime() > 0 && now.getTime() > tier.saleEndsAt.getTime()) {
      throw conflict('SALE_ENDED', 'Sale Ended', 'Sale window has closed for this tier');
    }

    const orderId = newOrderId();
    const reservedTtlMs = (this.deps.env.ORDER_TTL_SECONDS + 60) * 1000;

    let reserve: Awaited<ReturnType<StockGate['reserve']>>;
    try {
      reserve = await this.deps.stock.reserve({
        tierId: tier._id,
        eventId: tier.eventId,
        userId: input.userId,
        orderId,
        quantity: input.quantity,
        maxPerUser: tier.maxPerUser,
        saleStartsAt: tier.saleStartsAt,
        saleEndsAt: tier.saleEndsAt,
        reservedTtlMs,
        now,
      });
    } catch (error) {
      logger.error(
        { err: error, tierId: tier._id, requestId: input.requestId },
        'stock gate failure',
      );
      throw dependencyUnavailable('Stock gate is unavailable; purchase is fail-closed');
    }

    if (!reserve.ok) {
      if (reserve.reason === 'SOLD_OUT') throw soldOut();
      if (reserve.reason === 'LIMIT_EXCEEDED') {
        throw limitExceeded(`Maximum ${tier.maxPerUser} tickets per user for this event`);
      }
      if (reserve.reason === 'SALE_NOT_STARTED') {
        throw forbidden('Sale has not started for this tier');
      }
      if (reserve.reason === 'SALE_ENDED') {
        throw conflict('SALE_ENDED', 'Sale Ended', 'Sale window has closed for this tier');
      }
      throw dependencyUnavailable('Stock is not initialized for this tier');
    }

    const expiresAt = new Date(now.getTime() + this.deps.env.ORDER_TTL_SECONDS * 1000);
    const doc: OrderDoc = {
      _id: orderId,
      userId: input.userId,
      eventId: tier.eventId,
      tierId: tier._id,
      quantity: input.quantity,
      unitPrice: tier.price,
      total: tier.price * input.quantity,
      status: 'PENDING_PAYMENT',
      expiresAt,
      paymentAttempts: 0,
      reservationReleased: false,
      requestId: input.requestId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    try {
      await runInTransaction(this.deps.client, async (session) => {
        await this.deps.collections.orders.insertOne(doc, { session });
        await writeOutbox(
          this.deps.collections,
          {
            userId: doc.userId,
            aggregateType: 'order',
            aggregateId: doc._id,
            type: 'order.created',
            payload: {
              orderId: doc._id,
              eventId: doc.eventId,
              tierId: doc.tierId,
              quantity: doc.quantity,
              total: doc.total,
              expiresAt: doc.expiresAt.toISOString(),
            },
            requestId: input.requestId,
          },
          session,
        );
      });
    } catch (error) {
      logger.error(
        { err: error, orderId: doc._id, requestId: input.requestId },
        'order transaction failed, compensating stock reservation',
      );
      try {
        await this.deps.stock.release({
          tierId: tier._id,
          eventId: tier.eventId,
          userId: input.userId,
          orderId: doc._id,
        });
      } catch (releaseError) {
        logger.error(
          { err: releaseError, orderId: doc._id },
          'compensating stock release failed; reconciliation will recover',
        );
      }
      throw error;
    }

    metrics.ordersTotal.inc({ status: 'PENDING_PAYMENT' });
    await this.deps.pubsub.publish(`order:${doc._id}`, {
      type: 'order.status',
      status: doc.status,
    });
    return serializeOrder(doc);
  }

  async list(input: {
    userId: string;
    status?: OrderStatus;
    limit: number;
    cursor?: string;
  }): Promise<{ data: OrderView[]; nextCursor: string | null; hasMore: boolean }> {
    const filter: Record<string, unknown> = { userId: input.userId, deletedAt: null };
    if (input.status) filter.status = input.status;

    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.scope && cursor.scope !== input.userId) {
        throw badRequest('cursor does not belong to this user');
      }
      const createdAt = new Date(String((cursor.sort as Record<string, unknown>).createdAt));
      filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: cursor.id } }];
    }

    const docs = await this.deps.collections.orders
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .toArray();

    const hasMore = docs.length > input.limit;
    const page = docs.slice(0, input.limit);
    const last = page.at(-1);
    return {
      data: page.map(serializeOrder),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sort: { createdAt: last.createdAt.toISOString() },
              id: last._id,
              scope: input.userId,
            })
          : null,
      hasMore,
    };
  }

  async getById(orderId: string, userId: string, role: 'user' | 'admin'): Promise<OrderDoc> {
    const order = await this.deps.collections.orders.findOne({ _id: orderId, deletedAt: null });
    if (!order) throw notFound('Order not found');
    if (role !== 'admin' && order.userId !== userId) throw forbidden('You do not own this order');
    return order;
  }

  async cancel(orderId: string, userId: string, requestId: string): Promise<OrderView> {
    const order = await this.getById(orderId, userId, 'user');
    if (isTerminal(order.status)) {
      throw conflict(
        'INVALID_STATE_TRANSITION',
        'Invalid State Transition',
        `Order is already ${order.status}`,
      );
    }
    assertTransition(order.status, 'CANCELLED');

    const updated = await runInTransaction(this.deps.client, async (session) => {
      const result = await this.deps.collections.orders.findOneAndUpdate(
        {
          _id: order._id,
          userId: order.userId,
          status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED'] },
        },
        {
          $set: {
            status: 'CANCELLED',
            updatedAt: new Date(),
            reservationReleased: true,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!result) return null;
      await writeOutbox(
        this.deps.collections,
        {
          userId: order.userId,
          aggregateType: 'order',
          aggregateId: order._id,
          type: 'order.cancelled',
          payload: { orderId: order._id, reason: 'user_cancelled' },
          requestId,
        },
        session,
      );
      return result;
    });

    if (!updated) {
      throw conflict(
        'INVALID_STATE_TRANSITION',
        'Invalid State Transition',
        'Order status changed concurrently',
      );
    }

    await this.releaseReservation({
      order: updated,
      requestId,
      reason: 'user_cancelled',
    });
    metrics.ordersTotal.inc({ status: 'CANCELLED' });
    return serializeOrder(updated);
  }

  async releaseReservation(input: {
    order: Pick<OrderDoc, 'userId' | 'eventId' | 'tierId' | '_id' | 'quantity'>;
    requestId: string;
    reason: string;
  }): Promise<boolean> {
    try {
      const result = await this.deps.stock.release({
        tierId: input.order.tierId,
        eventId: input.order.eventId,
        userId: input.order.userId,
        orderId: input.order._id,
      });
      await this.deps.pubsub.publish(`stock:${input.order.eventId}`, {
        type: 'stock.released',
        tierId: input.order.tierId,
        orderId: input.order._id,
        reason: input.reason,
        remaining: result.remaining,
      });
      return result.released;
    } catch (error) {
      logger.error(
        { err: error, orderId: input.order._id, requestId: input.requestId },
        'stock release failed; reconciliation will recover',
      );
      return false;
    }
  }

  async markPaymentQueued(orderId: string, userId: string): Promise<OrderDoc> {
    const order = await this.getById(orderId, userId, 'user');
    assertTransition(order.status, 'PAYMENT_QUEUED');
    const updated = await this.deps.collections.orders.findOneAndUpdate(
      { _id: orderId, userId, status: order.status },
      { $set: { status: 'PAYMENT_QUEUED', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      throw conflict(
        'INVALID_STATE_TRANSITION',
        'Invalid State Transition',
        'Order status changed concurrently',
      );
    }
    metrics.ordersTotal.inc({ status: 'PAYMENT_QUEUED' });
    await this.deps.pubsub.publish(`order:${orderId}`, {
      type: 'order.status',
      status: 'PAYMENT_QUEUED',
    });
    return updated;
  }

  async expireDueOrders(limit: number): Promise<string[]> {
    const now = new Date();
    const due = await this.deps.collections.orders
      .find({
        status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED'] },
        expiresAt: { $lte: now },
      })
      .limit(limit)
      .toArray();

    const expired: string[] = [];
    for (const order of due) {
      const updated = await runInTransaction(this.deps.client, async (session) => {
        const result = await this.deps.collections.orders.findOneAndUpdate(
          {
            _id: order._id,
            userId: order.userId,
            status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED'] },
            expiresAt: { $lte: now },
          },
          { $set: { status: 'EXPIRED', updatedAt: new Date(), reservationReleased: true } },
          { returnDocument: 'after', session },
        );
        if (!result) return null;
        await writeOutbox(
          this.deps.collections,
          {
            userId: result.userId,
            aggregateType: 'order',
            aggregateId: result._id,
            type: 'order.expired',
            payload: { orderId: result._id, reason: 'expired' },
            requestId: 'system:expiry',
          },
          session,
        );
        return result;
      });
      if (!updated) continue;
      await this.releaseReservation({
        order: updated,
        requestId: 'system:expiry',
        reason: 'expired',
      });
      metrics.ordersTotal.inc({ status: 'EXPIRED' });
      expired.push(updated._id);
    }
    return expired;
  }

  async clearExpiredCache(): Promise<void> {
    await this.deps.cache.invalidateEvents();
  }
}
