import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newOrderId } from '../../src/shared/ids.ts';
import { getHarness, type Harness, resetDatabase } from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
  await resetDatabase(harness.container);
});

afterAll(async () => {
  await harness.stop();
});

const seedTierRow = async (input: {
  quota: number;
  maxPerUser?: number;
  saleStartsAt?: Date;
  saleEndsAt?: Date;
}) => {
  const now = new Date();
  const eventId = `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const tierId = `tier_${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
  await harness.container.collections.events.insertOne({
    _id: eventId,
    name: 'Stock Gate Event',
    description: 'x',
    category: 'music',
    city: 'jakarta',
    venue: 'Hall',
    startsAt: new Date(now.getTime() + 86_400_000),
    status: 'ON_SALE',
    searchText: 'stock gate event',
    createdBy: 'usr_system',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  await harness.container.collections.ticketTiers.insertOne({
    _id: tierId,
    eventId,
    name: 'Bronze',
    price: 100_000,
    quota: input.quota,
    saleStartsAt: input.saleStartsAt ?? new Date(now.getTime() - 60_000),
    saleEndsAt: input.saleEndsAt ?? new Date(now.getTime() + 3_600_000),
    maxPerUser: input.maxPerUser ?? 4,
    createdAt: now,
    updatedAt: now,
  });
  await harness.container.stock.prewarm(tierId, input.quota);
  return { eventId, tierId };
};

describe('redis stock gate lua semantics', () => {
  it('reserves stock and reports the remaining balance', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 10 });
    const outcome = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_1',
      orderId: newOrderId(),
      quantity: 3,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.remaining).toBe(7);
    expect(await harness.container.stock.getStock(tierId)).toBe(7);
  });

  it('rejects reservations above the remaining stock with SOLD_OUT', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 2 });
    const outcome = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_2',
      orderId: newOrderId(),
      quantity: 3,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('SOLD_OUT');
    expect(await harness.container.stock.getStock(tierId)).toBe(2);
  });

  it('enforces maxPerUser across multiple reservations by the same user', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 50, maxPerUser: 4 });
    const first = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_3',
      orderId: newOrderId(),
      quantity: 3,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(first.ok).toBe(true);
    const second = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_3',
      orderId: newOrderId(),
      quantity: 2,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('LIMIT_EXCEEDED');
  });

  it('is idempotent for the same order id', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 10 });
    const orderId = newOrderId();
    const input = {
      tierId,
      eventId,
      userId: 'usr_gate_user_4',
      orderId,
      quantity: 2,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    };
    const first = await harness.container.stock.reserve(input);
    const second = await harness.container.stock.reserve(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.idempotent).toBe(true);
    expect(await harness.container.stock.getStock(tierId)).toBe(8);
  });

  it('releases stock exactly once for a repeated release', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 10 });
    const orderId = newOrderId();
    await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_5',
      orderId,
      quantity: 4,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    const firstRelease = await harness.container.stock.release({
      tierId,
      eventId,
      userId: 'usr_gate_user_5',
      orderId,
    });
    const secondRelease = await harness.container.stock.release({
      tierId,
      eventId,
      userId: 'usr_gate_user_5',
      orderId,
    });
    expect(firstRelease.released).toBe(true);
    expect(secondRelease.released).toBe(false);
    expect(await harness.container.stock.getStock(tierId)).toBe(10);
  });

  it('rejects reservations before the sale window with SALE_NOT_STARTED', async () => {
    const { tierId, eventId } = await seedTierRow({
      quota: 10,
      saleStartsAt: new Date(Date.now() + 600_000),
    });
    const outcome = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_6',
      orderId: newOrderId(),
      quantity: 1,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() + 600_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('SALE_NOT_STARTED');
  });

  it('rejects reservations after the sale window with SALE_ENDED', async () => {
    const { tierId, eventId } = await seedTierRow({
      quota: 10,
      saleEndsAt: new Date(Date.now() - 1_000),
    });
    const outcome = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_7',
      orderId: newOrderId(),
      quantity: 1,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 3_600_000),
      saleEndsAt: new Date(Date.now() - 1_000),
      reservedTtlMs: 600_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('SALE_ENDED');
  });

  it('fails closed when stock has not been initialized', async () => {
    const { tierId, eventId } = await seedTierRow({ quota: 10 });
    await harness.container.stock.clearTierStock(tierId);
    const outcome = await harness.container.stock.reserve({
      tierId,
      eventId,
      userId: 'usr_gate_user_8',
      orderId: newOrderId(),
      quantity: 1,
      maxPerUser: 4,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 3_600_000),
      reservedTtlMs: 600_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('STOCK_UNAVAILABLE');
  });
});
