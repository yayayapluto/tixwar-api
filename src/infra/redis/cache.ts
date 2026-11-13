import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';
import { metrics } from '../metrics/registry.ts';

const logger = createLogger('cache');

export interface CacheReadOptions {
  ttlSeconds: number;
  jitterSeconds?: number;
  staleTtlSeconds?: number;
}

const VERSION_KEY = {
  events: 'events:ver',
  eventDetail: (eventId: string) => `event:${eventId}:ver`,
} as const;

const localInflight = new Map<string, Promise<unknown>>();

export class CacheStore {
  private readonly redis: Redis;
  private readonly env: Env;

  constructor(redis: Redis, env: Env) {
    this.redis = redis;
    this.env = env;
  }

  async getVersion(_scope: 'events'): Promise<string> {
    const value = await this.redis.get(VERSION_KEY.events);
    return value ?? '0';
  }

  async getEventVersion(eventId: string): Promise<string> {
    const value = await this.redis.get(VERSION_KEY.eventDetail(eventId));
    return value ?? '0';
  }

  async invalidateEvents(): Promise<void> {
    await this.redis.incr(VERSION_KEY.events);
  }

  async invalidateEvent(eventId: string): Promise<void> {
    await this.redis.incr(VERSION_KEY.eventDetail(eventId));
    await this.redis.incr(VERSION_KEY.events);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      logger.warn({ err: error, key }, 'cache read failed');
      return null;
    }
  }

  async set(key: string, value: unknown, options: CacheReadOptions): Promise<void> {
    const jitter = options.jitterSeconds ?? Math.ceil(options.ttlSeconds * 0.1);
    const ttl = options.ttlSeconds + Math.floor(Math.random() * (jitter + 1));
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      logger.warn({ err: error, key }, 'cache write failed');
    }
  }

  async setNegative(key: string): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify({ notFound: true }),
        'EX',
        this.env.CACHE_NEGATIVE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ err: error, key }, 'negative cache write failed');
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      logger.warn({ err: error, key }, 'cache delete failed');
    }
  }

  async remember<T>(
    key: string,
    cacheName: string,
    loader: () => Promise<T | null>,
    options: CacheReadOptions,
  ): Promise<{ value: T | null; hit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      metrics.cacheHitsTotal.inc({ cache: cacheName });
      return { value: cached, hit: true };
    }
    metrics.cacheMissesTotal.inc({ cache: cacheName });

    const existing = localInflight.get(key);
    if (existing) {
      return { value: (await existing) as T | null, hit: false };
    }

    const lockKey = `lock:${key}`;
    let acquiredLock = false;
    try {
      acquiredLock = (await this.redis.set(lockKey, '1', 'PX', 2000, 'NX')) === 'OK';
    } catch (error) {
      logger.warn({ err: error, key }, 'cache lock failed');
    }

    if (!acquiredLock) {
      const shared = localInflight.get(key);
      if (shared) return { value: (await shared) as T | null, hit: false };
      const stale = await this.get<T>(key);
      if (stale !== null) {
        metrics.cacheStaleServedTotal.inc({ cache: cacheName });
        return { value: stale, hit: false };
      }
    }

    const promise = (async () => {
      const value = await loader();
      if (value === null) await this.setNegative(key);
      else await this.set(key, value, options);
      return value;
    })();

    localInflight.set(key, promise);
    try {
      return { value: await promise, hit: false };
    } finally {
      localInflight.delete(key);
      if (acquiredLock) {
        try {
          await this.redis.del(lockKey);
        } catch {
          // lock expires on its own
        }
      }
    }
  }
}
