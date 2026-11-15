import { randomUUID } from 'node:crypto';
import type { Collections } from '../../infra/db/collections.ts';
import { notFound } from '../../shared/problem.ts';

export interface EventStatsView {
  eventId: string;
  sold: number;
  revenue: number;
  updatedAt: string;
}

const PAID_STATUSES = ['PAID', 'CONFIRMED'] as const;

export const serializeStats = (doc: {
  eventId: string;
  sold: number;
  revenue: number;
  updatedAt: Date;
}): EventStatsView => ({
  eventId: doc.eventId,
  sold: doc.sold,
  revenue: doc.revenue,
  updatedAt: doc.updatedAt.toISOString(),
});

export class EventStatsService {
  private readonly collections: Collections;

  constructor(collections: Collections) {
    this.collections = collections;
  }

  async get(eventId: string): Promise<EventStatsView> {
    const event = await this.collections.events.findOne({ _id: eventId, deletedAt: null });
    if (!event) throw notFound('Event not found');

    const cached = await this.collections.eventStats.findOne({ eventId });
    if (cached) return serializeStats(cached);

    const [orders, tickets] = await Promise.all([
      this.collections.orders
        .find({ eventId, status: { $in: [...PAID_STATUSES] } }, { projection: { total: 1 } })
        .toArray(),
      this.collections.tickets.find({ eventId }, { projection: { _id: 1 } }).toArray(),
    ]);

    const doc = {
      _id: randomUUID(),
      eventId,
      sold: tickets.length,
      revenue: orders.reduce((total, order) => total + order.total, 0),
      updatedAt: new Date(),
    };

    await this.collections.eventStats.updateOne(
      { eventId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return serializeStats(doc);
  }
}
