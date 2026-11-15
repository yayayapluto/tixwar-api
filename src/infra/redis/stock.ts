import type { Redis } from 'ioredis';
import { metrics } from '../metrics/registry.ts';

export const RESERVE_SCRIPT = `
local stockKey = KEYS[1]
local reservedKey = KEYS[2]
local quantity = tonumber(ARGV[1])
local maxPerUser = tonumber(ARGV[2])
local saleStartsAt = tonumber(ARGV[3])
local saleEndsAt = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local orderId = ARGV[6]
local reservedTtl = tonumber(ARGV[7])

if quantity == nil or quantity <= 0 then
  return {-6, 0}
end

local existing = redis.call('HGET', reservedKey, orderId)
if existing then
  return {0, tonumber(redis.call('GET', stockKey) or '-1')}
end

if now < saleStartsAt then
  return {-3, saleStartsAt}
end

if saleEndsAt > 0 and now > saleEndsAt then
  return {-5, saleEndsAt}
end

local stockRaw = redis.call('GET', stockKey)
if not stockRaw then
  return {-4, 0}
end
local stock = tonumber(stockRaw)

local userTotal = 0
local entries = redis.call('HGETALL', reservedKey)
for i = 2, #entries, 2 do
  userTotal = userTotal + tonumber(entries[i])
end

if userTotal + quantity > maxPerUser then
  return {-2, userTotal}
end

if stock < quantity then
  return {-1, stock}
end

local remaining = redis.call('DECRBY', stockKey, quantity)
redis.call('HSET', reservedKey, orderId, quantity)
redis.call('PEXPIRE', reservedKey, reservedTtl)
return {1, remaining}
`;

export const RELEASE_SCRIPT = `
local stockKey = KEYS[1]
local reservedKey = KEYS[2]
local orderId = ARGV[1]

local quantity = redis.call('HGET', reservedKey, orderId)
if not quantity then
  return {0, tonumber(redis.call('GET', stockKey) or '-1')}
end

redis.call('HDEL', reservedKey, orderId)
local remaining = redis.call('INCRBY', stockKey, tonumber(quantity))
return {1, remaining}
`;

export const PREWARM_SCRIPT = `
local stockKey = KEYS[1]
local quota = tonumber(ARGV[1])
local existing = redis.call('GET', stockKey)
if existing then
  return {0, tonumber(existing)}
end
redis.call('SET', stockKey, quota)
return {1, quota}
`;

export const SET_STOCK_SCRIPT = `
local stockKey = KEYS[1]
local value = tonumber(ARGV[1])
redis.call('SET', stockKey, value)
return {1, value}
`;

export const stockKey = (tierId: string): string => `stock:${tierId}`;

export const reservedKey = (eventId: string, userId: string): string =>
  `reserved:${eventId}:${userId}`;

export type ReserveOutcome =
  | { ok: true; remaining: number; idempotent: boolean }
  | {
      ok: false;
      reason:
        | 'SOLD_OUT'
        | 'LIMIT_EXCEEDED'
        | 'SALE_NOT_STARTED'
        | 'SALE_ENDED'
        | 'STOCK_UNAVAILABLE'
        | 'INVALID_QUANTITY';
      remaining: number;
    };

const REASON_BY_CODE: Record<
  number,
  | 'SOLD_OUT'
  | 'LIMIT_EXCEEDED'
  | 'SALE_NOT_STARTED'
  | 'SALE_ENDED'
  | 'STOCK_UNAVAILABLE'
  | 'INVALID_QUANTITY'
> = {
  [-1]: 'SOLD_OUT',
  [-2]: 'LIMIT_EXCEEDED',
  [-3]: 'SALE_NOT_STARTED',
  [-4]: 'STOCK_UNAVAILABLE',
  [-5]: 'SALE_ENDED',
  [-6]: 'INVALID_QUANTITY',
};

export interface ReserveInput {
  tierId: string;
  eventId: string;
  userId: string;
  orderId: string;
  quantity: number;
  maxPerUser: number;
  saleStartsAt: Date;
  saleEndsAt: Date;
  reservedTtlMs: number;
  now?: Date;
}

export class StockGate {
  private readonly redis: Redis;
  private readonly scriptShas = new Map<string, string>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private async evalScript(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    let sha = this.scriptShas.get(script);
    if (!sha) {
      sha = (await this.redis.script('LOAD', script)) as string;
      this.scriptShas.set(script, sha);
    }
    try {
      return await this.redis.evalsha(sha, keys.length, ...keys, ...args.map(String));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NOSCRIPT')) {
        sha = (await this.redis.script('LOAD', script)) as string;
        this.scriptShas.set(script, sha);
        return await this.redis.evalsha(sha, keys.length, ...keys, ...args.map(String));
      }
      throw error;
    }
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const now = input.now ?? new Date();
    const raw = (await this.evalScript(
      RESERVE_SCRIPT,
      [stockKey(input.tierId), reservedKey(input.eventId, input.userId)],
      [
        input.quantity,
        input.maxPerUser,
        input.saleStartsAt.getTime(),
        input.saleEndsAt.getTime(),
        now.getTime(),
        input.orderId,
        input.reservedTtlMs,
      ],
    )) as [number, number];

    const [code, value] = raw;
    if (code === 1) {
      metrics.stockGateOperations.inc({ operation: 'reserve', result: 'ok' });
      metrics.stockRemaining.set({ tier: input.tierId }, value);
      return { ok: true, remaining: value, idempotent: false };
    }
    if (code === 0) {
      metrics.stockGateOperations.inc({ operation: 'reserve', result: 'idempotent' });
      return { ok: true, remaining: value, idempotent: true };
    }
    const reason = REASON_BY_CODE[code] ?? 'STOCK_UNAVAILABLE';
    metrics.stockGateOperations.inc({ operation: 'reserve', result: reason.toLowerCase() });
    return { ok: false, reason, remaining: value };
  }

  async release(input: {
    tierId: string;
    eventId: string;
    userId: string;
    orderId: string;
  }): Promise<{ released: boolean; remaining: number }> {
    const raw = (await this.evalScript(
      RELEASE_SCRIPT,
      [stockKey(input.tierId), reservedKey(input.eventId, input.userId)],
      [input.orderId],
    )) as [number, number];
    const [code, remaining] = raw;
    metrics.stockGateOperations.inc({
      operation: 'release',
      result: code === 1 ? 'released' : 'noop',
    });
    if (code === 1) metrics.stockRemaining.set({ tier: input.tierId }, remaining);
    return { released: code === 1, remaining };
  }

  async prewarm(
    tierId: string,
    quota: number,
  ): Promise<{ initialized: boolean; remaining: number }> {
    const raw = (await this.evalScript(PREWARM_SCRIPT, [stockKey(tierId)], [quota])) as [
      number,
      number,
    ];
    return { initialized: raw[0] === 1, remaining: raw[1] };
  }

  async setStock(tierId: string, value: number): Promise<number> {
    const raw = (await this.evalScript(SET_STOCK_SCRIPT, [stockKey(tierId)], [value])) as [
      number,
      number,
    ];
    metrics.stockRemaining.set({ tier: tierId }, raw[1]);
    return raw[1];
  }

  async getStock(tierId: string): Promise<number | null> {
    const value = await this.redis.get(stockKey(tierId));
    return value === null ? null : Number(value);
  }

  async getUserReservations(eventId: string, userId: string): Promise<Record<string, number>> {
    const entries = await this.redis.hgetall(reservedKey(eventId, userId));
    const result: Record<string, number> = {};
    for (const [orderId, quantity] of Object.entries(entries)) {
      result[orderId] = Number(quantity);
    }
    return result;
  }

  async replaceReservation(input: {
    tierId: string;
    eventId: string;
    userId: string;
    orderId: string;
    quantity: number;
    reservedTtlMs: number;
  }): Promise<void> {
    const key = reservedKey(input.eventId, input.userId);
    await this.redis
      .multi()
      .hset(key, input.orderId, String(input.quantity))
      .pexpire(key, input.reservedTtlMs)
      .exec();
  }

  async dropReservation(eventId: string, userId: string, orderId: string): Promise<void> {
    await this.redis.hdel(reservedKey(eventId, userId), orderId);
  }

  async clearTierStock(tierId: string): Promise<void> {
    await this.redis.del(stockKey(tierId));
  }
}

export const assertReserveOutcome = (outcome: ReserveOutcome): void => {
  if (!outcome.ok) throw new Error(`stock reserve failed: ${outcome.reason}`);
};
