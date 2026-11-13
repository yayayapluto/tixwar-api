import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { getEnv } from '../../src/config/env.ts';
import { connectRedis, type RedisContext } from '../../src/infra/redis/client.ts';
import { errorHandler } from '../../src/middleware/error.ts';
import { createRateLimiters, type RateLimiterSet } from '../../src/middleware/rateLimit.ts';

let redisCtx: RedisContext;
let limiters: RateLimiterSet;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const env = { ...getEnv(), RATE_LIMIT_ANON: 3, RATE_LIMIT_LOGIN: 2 };
  redisCtx = await connectRedis(env);
  limiters = createRateLimiters(env, redisCtx.client);

  const app = express();
  app.set('trust proxy', true);
  app.get(
    '/browse',
    limiters.middleware('anon-browse', (req) => req.ip ?? 'unknown'),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.get(
    '/login',
    limiters.middleware('login', (req) => req.ip ?? 'unknown'),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  const keys = await redisCtx.client.keys('rl:*');
  if (keys.length > 0) await redisCtx.client.del(...keys);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await limiters.close();
  await redisCtx.close();
});

describe('rate limiter middleware', () => {
  it('allows requests up to the tier limit and reports RateLimit headers', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const response = await fetch(`${baseUrl}/browse`, {
      headers: { 'x-forwarded-for': ip },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBe('3');
    expect(response.headers.get('ratelimit-remaining')).toBe('2');
    expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
  }, 30_000);

  it('rejects the request past the limit with 429, Retry-After and problem+json', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${baseUrl}/browse`, {
        headers: { 'x-forwarded-for': ip },
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBeTruthy();
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        const body = (await response.json()) as { code: string; status: number };
        expect(body.code).toBe('RATE_LIMITED');
        expect(body.status).toBe(429);
      }
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  }, 30_000);

  it('keeps separate budgets per tier and per key', async () => {
    const ipA = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const ipB = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fetch(`${baseUrl}/browse`, { headers: { 'x-forwarded-for': ipA } });
    }
    const blocked = await fetch(`${baseUrl}/browse`, { headers: { 'x-forwarded-for': ipA } });
    expect(blocked.status).toBe(429);

    const otherKey = await fetch(`${baseUrl}/browse`, { headers: { 'x-forwarded-for': ipB } });
    expect(otherKey.status).toBe(200);

    const otherTier = await fetch(`${baseUrl}/login`, { headers: { 'x-forwarded-for': ipA } });
    expect(otherTier.status).toBe(200);
  }, 30_000);

  it('falls back to a stricter in-memory limiter when redis fails', async () => {
    const env = { ...getEnv(), RATE_LIMIT_ANON: 100 };
    const brokenRedis = {
      status: 'ready',
      consume: () => {
        throw new Error('redis connection lost');
      },
      script: () => {
        throw new Error('redis connection lost');
      },
    };
    const isolated = createRateLimiters(env, brokenRedis as never);
    const app = express();
    app.set('trust proxy', true);
    app.get(
      '/browse',
      isolated.middleware('anon-browse', () => 'fallback-key'),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(errorHandler);
    const isolatedServer = app.listen(0);
    await new Promise<void>((resolve) => {
      if (isolatedServer.listening) resolve();
      else isolatedServer.once('listening', () => resolve());
    });
    const address = isolatedServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/browse`);
      expect(response.status).toBe(200);
      expect(response.headers.get('ratelimit-limit')).toBe('50');
    } finally {
      await new Promise<void>((resolve) => {
        isolatedServer.close(() => resolve());
      });
      await isolated.close();
    }
  }, 30_000);
});
