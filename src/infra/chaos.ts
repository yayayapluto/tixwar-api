import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';

export type ChaosTarget = 'redis' | 'mongo';

export interface ChaosRule {
  latencyMs: number;
  errorRatePercent: number;
  until: number;
}

const active = new Map<ChaosTarget, ChaosRule>();
const timers = new Map<ChaosTarget, Timer>();

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const clear = (target: ChaosTarget): void => {
  clearTimeout(timers.get(target));
  timers.delete(target);
  active.delete(target);
};

export const injectChaos = (
  target: ChaosTarget,
  input: { latencyMs: number; errorRatePercent: number; durationMs: number },
): void => {
  clear(target);
  active.set(target, {
    latencyMs: input.latencyMs,
    errorRatePercent: input.errorRatePercent,
    until: Date.now() + input.durationMs,
  });
  timers.set(
    target,
    setTimeout(() => clear(target), input.durationMs),
  );
};

export const recoverChaos = (target: ChaosTarget): void => {
  clear(target);
};

export const chaosActive = (target: ChaosTarget): boolean => active.has(target);

const currentRule = (target: ChaosTarget): ChaosRule | undefined => {
  const entry = active.get(target);
  if (!entry) return undefined;
  if (Date.now() >= entry.until) {
    clear(target);
    return undefined;
  }
  return entry;
};

export const maybeDelay = async (target: ChaosTarget): Promise<void> => {
  const entry = currentRule(target);
  if (!entry || entry.latencyMs <= 0) return;
  await sleep(entry.latencyMs);
};

export const maybeThrow = (target: ChaosTarget): void => {
  const entry = currentRule(target);
  if (!entry || entry.errorRatePercent <= 0) return;
  if (Math.random() * 100 < entry.errorRatePercent) {
    throw new Error(`chaos: injected ${target} failure`);
  }
};

export const instrumentRedisChaos = (redis: Redis): void => {
  const originalSend = redis.sendCommand;
  redis.sendCommand = async (command) => {
    await maybeDelay('redis');
    maybeThrow('redis');
    return originalSend.call(redis, command);
  };
};

const PROMISE_METHODS: Record<string, true> = {
  findOne: true,
  insertOne: true,
  insertMany: true,
  updateOne: true,
  updateMany: true,
  replaceOne: true,
  deleteOne: true,
  deleteMany: true,
  findOneAndUpdate: true,
  findOneAndDelete: true,
  findOneAndReplace: true,
  countDocuments: true,
  estimatedDocumentCount: true,
  bulkWrite: true,
};

const CURSOR_METHODS: Record<string, true> = {
  find: true,
  aggregate: true,
  distinct: true,
};

const CURSOR_ASYNC_METHODS: Record<string, true> = {
  toArray: true,
  next: true,
  hasNext: true,
  forEach: true,
  close: true,
};

const wrapCursor = (cursor: unknown): unknown => {
  if (cursor === null || typeof cursor !== 'object') return cursor;
  return new Proxy(cursor as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const name = String(prop);
      if (CURSOR_ASYNC_METHODS[name] && typeof value === 'function') {
        return async (...args: unknown[]) => {
          await maybeDelay('mongo');
          maybeThrow('mongo');
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
};

const wrapCollection = (collection: unknown): unknown => {
  if (collection === null || typeof collection !== 'object') return collection;
  return new Proxy(collection as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const name = String(prop);
      if (typeof value !== 'function') return value;
      if (PROMISE_METHODS[name]) {
        return async (...args: unknown[]) => {
          await maybeDelay('mongo');
          maybeThrow('mongo');
          return value.apply(target, args);
        };
      }
      if (CURSOR_METHODS[name]) {
        return (...args: unknown[]) => wrapCursor(value.apply(target, args));
      }
      return value;
    },
  });
};

const wrapDb = (db: unknown): unknown => {
  if (db === null || typeof db !== 'object') return db;
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'collection' && typeof value === 'function') {
        return (...args: unknown[]) => wrapCollection(value.apply(target, args));
      }
      return value;
    },
  });
};

export const instrumentMongoChaos = (client: MongoClient): void => {
  const originalDb = client.db.bind(client) as (name?: string, options?: unknown) => unknown;
  const patchedDb = (name?: string, options?: unknown): unknown =>
    wrapDb(originalDb(name, options));
  Object.defineProperty(client, 'db', {
    value: patchedDb,
    configurable: true,
    writable: true,
  });
};
