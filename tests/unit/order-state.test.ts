import { describe, expect, it } from 'bun:test';
import type { OrderStatus } from '../../src/infra/db/types.ts';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/modules/orders/state.ts';

const ALL: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAYMENT_QUEUED',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
];

describe('order state machine', () => {
  it('allows every transition declared by the PRD diagram', () => {
    const allowed: Array<[OrderStatus, OrderStatus]> = [
      ['PENDING_PAYMENT', 'PAYMENT_QUEUED'],
      ['PENDING_PAYMENT', 'PAID'],
      ['PENDING_PAYMENT', 'PAYMENT_FAILED'],
      ['PENDING_PAYMENT', 'EXPIRED'],
      ['PENDING_PAYMENT', 'CANCELLED'],
      ['PAYMENT_QUEUED', 'PAID'],
      ['PAYMENT_QUEUED', 'PAYMENT_FAILED'],
      ['PAYMENT_QUEUED', 'EXPIRED'],
      ['PAYMENT_QUEUED', 'CANCELLED'],
      ['PAID', 'CONFIRMED'],
    ];
    for (const [from, to] of allowed) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects illegal transitions with INVALID_STATE_TRANSITION', () => {
    const illegal: Array<[OrderStatus, OrderStatus]> = [
      ['CONFIRMED', 'PAID'],
      ['EXPIRED', 'PAID'],
      ['CANCELLED', 'PAID'],
      ['PAYMENT_FAILED', 'PAYMENT_QUEUED'],
      ['PAID', 'CANCELLED'],
      ['CONFIRMED', 'EXPIRED'],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(/cannot transition/);
    }
  });

  it('marks terminal statuses and forbids any outgoing transition', () => {
    for (const status of ALL) {
      const terminal = isTerminal(status);
      expect(terminal).toBe(
        ['CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'].includes(status),
      );
      if (terminal) expect(ALLOWED_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('keeps CONFIRMED reachable only from PAID', () => {
    const sources = ALL.filter((status) => canTransition(status, 'CONFIRMED'));
    expect(sources).toEqual(['PAID']);
  });
});
