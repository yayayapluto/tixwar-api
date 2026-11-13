import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import {
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
} from 'rate-limiter-flexible';
import type { Env } from '../config/env.ts';
import { metrics } from '../infra/metrics/registry.ts';
import { createLogger } from '../shared/logger.ts';
import { rateLimited } from '../shared/problem.ts';

const logger = createLogger('rate-limit');

export type RateLimitTier =
  | 'anon-browse'
  | 'global'
  | 'login'
  | 'order-user'
  | 'order-ip'
  | 'pay-user';

export interface TierDefinition {
  tier: RateLimitTier;
  points: number;
  durationSeconds: number;
}

export const buildTierDefinitions = (env: Env): TierDefinition[] => [
  { tier: 'anon-browse', points: env.RATE_LIMIT_ANON, durationSeconds: 60 },
  { tier: 'global', points: env.RATE_LIMIT_GLOBAL, durationSeconds: 60 },
  { tier: 'login', points: env.RATE_LIMIT_LOGIN, durationSeconds: 60 },
  { tier: 'order-user', points: env.RATE_LIMIT_ORDER_USER, durationSeconds: 60 },
  { tier: 'order-ip', points: env.RATE_LIMIT_ORDER_IP, durationSeconds: 60 },
  { tier: 'pay-user', points: env.RATE_LIMIT_PAY_USER, durationSeconds: 60 },
];

export interface RateLimiterSet {
  limiters: Record<RateLimitTier, RateLimiterAbstract>;
  fallbacks: Record<RateLimitTier, RateLimiterMemory>;
  middleware: (tier: RateLimitTier, keyGenerator: (req: Request) => string) => RequestHandler;
  close: () => Promise<void>;
}

interface ConsumeResult {
  remaining: number;
  limit: number;
  resetSeconds: number;
  usedFallback: boolean;
}

const consume = async (
  limiter: RateLimiterAbstract,
  fallback: RateLimiterMemory,
  key: string,
  points: number,
  durationSeconds: number,
): Promise<ConsumeResult> => {
  try {
    const result = await limiter.consume(key, 1);
    return {
      remaining: result.remainingPoints,
      limit: points,
      resetSeconds: Math.max(1, Math.ceil(result.msBeforeNext / 1000)),
      usedFallback: false,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'remainingPoints' in error) {
      const rejected = error as { remainingPoints: number; msBeforeNext: number };
      return {
        remaining: rejected.remainingPoints,
        limit: points,
        resetSeconds: Math.max(1, Math.ceil(rejected.msBeforeNext / 1000)),
        usedFallback: false,
      };
    }
    metrics.rateLimitFallbackTotal.inc();
    logger.warn({ err: error, key }, 'redis rate limiter unavailable, using in-memory fallback');
    try {
      const result = await fallback.consume(key, 1);
      return {
        remaining: result.remainingPoints,
        limit: fallback.points,
        resetSeconds: Math.max(1, Math.ceil(result.msBeforeNext / 1000)),
        usedFallback: true,
      };
    } catch (fallbackError) {
      const rejected = fallbackError as { remainingPoints: number; msBeforeNext: number };
      return {
        remaining: rejected.remainingPoints ?? 0,
        limit: fallback.points,
        resetSeconds: Math.max(
          1,
          Math.ceil((rejected.msBeforeNext ?? durationSeconds * 1000) / 1000),
        ),
        usedFallback: true,
      };
    }
  }
};

export const createRateLimiters = (env: Env, redis: Redis): RateLimiterSet => {
  const definitions = buildTierDefinitions(env);
  const limiters = {} as Record<RateLimitTier, RateLimiterAbstract>;
  const fallbacks = {} as Record<RateLimitTier, RateLimiterMemory>;

  for (const definition of definitions) {
    limiters[definition.tier] = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `rl:${definition.tier}`,
      points: definition.points,
      duration: definition.durationSeconds,
      blockDuration: 0,
    });
    fallbacks[definition.tier] = new RateLimiterMemory({
      keyPrefix: `rl:fallback:${definition.tier}`,
      points: Math.max(1, Math.floor(definition.points / 2)),
      duration: definition.durationSeconds,
      blockDuration: 0,
    });
  }

  const middleware = (
    tier: RateLimitTier,
    keyGenerator: (req: Request) => string,
  ): RequestHandler => {
    const definition = definitions.find((entry) => entry.tier === tier)!;
    return async (req: Request, res: Response, next: NextFunction) => {
      const key = keyGenerator(req);
      const outcome = await consume(
        limiters[tier],
        fallbacks[tier],
        key,
        definition.points,
        definition.durationSeconds,
      );
      res.setHeader('RateLimit-Limit', String(outcome.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, outcome.remaining)));
      res.setHeader('RateLimit-Reset', String(outcome.resetSeconds));
      if (outcome.remaining < 0) {
        metrics.rateLimitRejectedTotal.inc({ tier });
        res.setHeader('Retry-After', String(outcome.resetSeconds));
        next(rateLimited(`Rate limit exceeded for ${tier}`, outcome.resetSeconds));
        return;
      }
      next();
    };
  };

  return {
    limiters,
    fallbacks,
    middleware,
    close: async () => {
      await Promise.allSettled(Object.values(limiters).map((limiter) => limiter.delete?.('noop')));
    },
  };
};

export const clientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
};

export const userOrIpKey = (req: Request): string =>
  req.principal ? `user:${req.principal.id}` : `ip:${clientIp(req)}`;
