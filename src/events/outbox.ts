import type { ClientSession } from 'mongodb';
import type { Collections } from '../infra/db/collections.ts';
import type { OutboxEventDoc } from '../infra/db/types.ts';
import { newOutboxEventId } from '../shared/ids.ts';

export const EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.confirmed',
  'order.expired',
  'order.cancelled',
  'payment.requested',
  'payment.succeeded',
  'payment.failed',
  'stock.released',
  'notification.email',
  'webhook.deliver',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope {
  id: string;
  type: EventType;
  occurredAt: string;
  requestId: string;
  aggregateId: string;
  userId: string;
  data: Record<string, unknown>;
  schemaVersion: number;
}

export interface OutboxWriteInput {
  userId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  requestId: string;
  occurredAt?: Date;
}

export const buildOutboxDoc = (input: OutboxWriteInput): OutboxEventDoc => {
  const now = input.occurredAt ?? new Date();
  return {
    _id: newOutboxEventId(),
    userId: input.userId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    type: input.type,
    payload: input.payload,
    status: 'PENDING',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    leaseUntil: null,
    lastError: null,
    requestId: input.requestId,
  };
};

export const writeOutbox = async (
  collections: Collections,
  input: OutboxWriteInput,
  session?: ClientSession,
): Promise<OutboxEventDoc> => {
  const doc = buildOutboxDoc(input);
  await collections.outboxEvents.insertOne(doc, { session });
  return doc;
};

export const toEnvelope = (doc: OutboxEventDoc): EventEnvelope => ({
  id: doc._id,
  type: doc.type as EventType,
  occurredAt: doc.createdAt.toISOString(),
  requestId: doc.requestId,
  aggregateId: doc.aggregateId,
  userId: doc.userId,
  data: doc.payload,
  schemaVersion: 1,
});

export const deterministicJobId = (eventId: string): string => `job-${eventId}`;
