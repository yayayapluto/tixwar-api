import type { MongoClient } from 'mongodb';
import { writeOutbox } from '../../events/outbox.ts';
import type { BreakerRegistry } from '../../infra/breaker/registry.ts';
import { runInTransaction } from '../../infra/db/client.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { OrderDoc, TicketDoc } from '../../infra/db/types.ts';
import { metrics } from '../../infra/metrics/registry.ts';
import type { PubSub } from '../../infra/redis/pubsub.ts';
import type { StorageContext } from '../../infra/storage/minio.ts';
import { decodeCursor, encodeCursor } from '../../shared/cursor.ts';
import { sha256Hex } from '../../shared/hash.ts';
import { newTicketId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { notFound } from '../../shared/problem.ts';

const logger = createLogger('tickets');

export interface TicketServiceDeps {
  collections: Collections;
  client: MongoClient;
  storage: StorageContext;
  breakers: BreakerRegistry;
  pubsub: PubSub;
}

export interface TicketView {
  id: string;
  orderId: string;
  eventId: string;
  tierId: string;
  code: string;
  issuedAt: string;
}

export const serializeTicket = (doc: TicketDoc): TicketView => ({
  id: doc._id,
  orderId: doc.orderId,
  eventId: doc.eventId,
  tierId: doc.tierId,
  code: doc.code,
  issuedAt: doc.issuedAt.toISOString(),
});

export const ticketObjectKey = (userId: string, ticketId: string): string =>
  `tickets/${userId}/${ticketId}.png`;

export const ticketCode = (orderId: string, ticketId: string): string =>
  `TW-${sha256Hex(`${orderId}:${ticketId}`).slice(0, 20).toUpperCase()}`;

const QR_SVG = (code: string): string => {
  const size = 21;
  const cells: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hash = sha256Hex(`${code}:${x}:${y}`);
      const on = Number.parseInt(hash.slice(0, 2), 16) % 2 === 0;
      if (!on) continue;
      cells.push(`<rect x="${x * 4}" y="${y * 4}" width="4" height="4"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 4}" height="${size * 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`;
};

export class TicketService {
  private readonly deps: TicketServiceDeps;

  constructor(deps: TicketServiceDeps) {
    this.deps = deps;
  }

  async issueForOrder(input: {
    orderId: string;
    userId: string;
    requestId: string;
  }): Promise<{ ticket: TicketDoc; order: OrderDoc } | null> {
    const order = await this.deps.collections.orders.findOne({
      _id: input.orderId,
      userId: input.userId,
      deletedAt: null,
    });
    if (!order) throw notFound('Order not found');

    if (order.status === 'CONFIRMED') {
      const existing = await this.deps.collections.tickets.findOne({
        userId: order.userId,
        orderId: order._id,
      });
      if (existing) return { ticket: existing, order };
      return null;
    }

    if (order.status !== 'PAID') return null;

    const ticketId = newTicketId();
    const code = ticketCode(order._id, ticketId);
    const qrObjectKey = ticketObjectKey(order.userId, ticketId);
    const ticket: TicketDoc = {
      _id: ticketId,
      orderId: order._id,
      userId: order.userId,
      eventId: order.eventId,
      tierId: order.tierId,
      code,
      qrObjectKey,
      issuedAt: new Date(),
    };

    const result = await runInTransaction(this.deps.client, async (session) => {
      const existing = await this.deps.collections.tickets.findOne(
        { userId: order.userId, orderId: order._id },
        { session },
      );
      if (existing) return { ticket: existing, order };

      await this.deps.collections.tickets.insertOne(ticket, { session });
      const confirmed = await this.deps.collections.orders.findOneAndUpdate(
        { _id: order._id, userId: order.userId, status: 'PAID' },
        { $set: { status: 'CONFIRMED', updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!confirmed) return null;

      await writeOutbox(
        this.deps.collections,
        {
          userId: order.userId,
          aggregateType: 'order',
          aggregateId: order._id,
          type: 'order.confirmed',
          payload: {
            orderId: order._id,
            ticketId: ticket._id,
            code: ticket.code,
            eventId: order.eventId,
          },
          requestId: input.requestId,
        },
        session,
      );
      return { ticket, order: confirmed };
    });

    if (!result) return null;
    metrics.ordersTotal.inc({ status: 'CONFIRMED' });

    await this.uploadQr(result.ticket);
    await this.deps.pubsub.publish(`order:${order._id}`, {
      type: 'order.status',
      status: 'CONFIRMED',
      ticketId: result.ticket._id,
    });
    return result;
  }

  private async uploadQr(ticket: TicketDoc): Promise<void> {
    const upload = this.deps.breakers.get(
      'minio',
      async (doc: TicketDoc) => {
        const body = Buffer.from(QR_SVG(doc.code), 'utf8');
        await this.deps.storage.client.putObject(
          this.deps.storage.bucket,
          doc.qrObjectKey,
          body,
          body.length,
          { 'Content-Type': 'image/svg+xml' },
        );
      },
      { timeout: 3000 },
    );
    try {
      await upload.fire(ticket);
    } catch (error) {
      logger.warn(
        { err: error, ticketId: ticket._id },
        'QR upload failed; presign will retry later',
      );
    }
  }

  async list(input: {
    userId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ data: TicketView[]; nextCursor: string | null; hasMore: boolean }> {
    const filter: Record<string, unknown> = { userId: input.userId };
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      filter._id = { $gt: cursor.id };
    }
    const docs = await this.deps.collections.tickets
      .find(filter)
      .sort({ _id: 1 })
      .limit(input.limit + 1)
      .toArray();
    const hasMore = docs.length > input.limit;
    const page = docs.slice(0, input.limit);
    const last = page.at(-1);
    return {
      data: page.map(serializeTicket),
      nextCursor:
        hasMore && last
          ? encodeCursor({ sort: { _id: last._id }, id: last._id, scope: input.userId })
          : null,
      hasMore,
    };
  }

  async getById(
    ticketId: string,
    userId: string,
    role: 'user' | 'admin',
  ): Promise<{ ticket: TicketDoc; qrUrl: string }> {
    const ticket = await this.deps.collections.tickets.findOne({ _id: ticketId });
    if (!ticket) throw notFound('Ticket not found');
    if (role !== 'admin' && ticket.userId !== userId) throw notFound('Ticket not found');

    let qrUrl = '';
    try {
      await this.uploadQr(ticket);
      qrUrl = await this.deps.storage.presignedGet(ticket.qrObjectKey);
    } catch (error) {
      logger.warn({ err: error, ticketId: ticket._id }, 'presigned URL unavailable');
    }
    return { ticket, qrUrl };
  }
}
