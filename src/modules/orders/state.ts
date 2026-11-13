import type { ClientSession } from 'mongodb';
import type { Collections } from '../../infra/db/collections.ts';
import type { OrderStatus } from '../../infra/db/types.ts';
import { invalidStateTransition } from '../../shared/problem.ts';

export const ORDER_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAYMENT_QUEUED',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
];

export const TERMINAL_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
];

export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['PAYMENT_QUEUED', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAYMENT_QUEUED: ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAID: ['CONFIRMED'],
  CONFIRMED: [],
  PAYMENT_FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

export const assertTransition = (from: OrderStatus, to: OrderStatus): void => {
  if (!canTransition(from, to)) {
    throw invalidStateTransition(`Order cannot transition from ${from} to ${to}`);
  }
};

export const isTerminal = (status: OrderStatus): boolean => TERMINAL_STATUSES.includes(status);

export const transitionOrder = async (
  collections: Collections,
  input: {
    orderId: string;
    userId: string;
    from: OrderStatus[];
    to: OrderStatus;
    set?: Record<string, unknown>;
    session?: ClientSession;
  },
): Promise<boolean> => {
  for (const from of input.from) {
    if (!canTransition(from, input.to)) {
      throw invalidStateTransition(`Order cannot transition from ${from} to ${input.to}`);
    }
  }
  const result = await collections.orders.updateOne(
    { _id: input.orderId, userId: input.userId, status: { $in: input.from } },
    { $set: { status: input.to, updatedAt: new Date(), ...(input.set ?? {}) } },
    { session: input.session, writeConcern: { w: 'majority' } },
  );
  return result.modifiedCount === 1;
};
