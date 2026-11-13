import CircuitBreaker from 'opossum';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';
import { metrics } from '../metrics/registry.ts';

const logger = createLogger('breaker');

export type BreakerName = 'payment-gateway' | 'smtp' | 'webhook' | 'minio';

export interface BreakerRegistry {
  get: <TArgs extends unknown[], TResult>(
    name: BreakerName,
    action: (...args: TArgs) => Promise<TResult>,
    options?: { timeout?: number },
  ) => CircuitBreaker<TArgs, TResult>;
  stateOf: (name: BreakerName) => string;
  states: () => Record<string, string>;
}

const STATE_VALUE: Record<string, number> = { closed: 0, open: 1, 'half-open': 2 };

export const createBreakerRegistry = (env: Env): BreakerRegistry => {
  const breakers = new Map<string, CircuitBreaker<unknown[], unknown>>();

  const registerState = (name: string, breaker: CircuitBreaker<unknown[], unknown>): void => {
    const publish = (): void => {
      const state = breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed';
      metrics.circuitBreakerState.set({ name }, STATE_VALUE[state] ?? 0);
    };
    publish();
    breaker.on('open', publish);
    breaker.on('close', publish);
    breaker.on('halfOpen', publish);
    breaker.on('failure', () => metrics.circuitBreakerFailures.inc({ name }));
  };

  return {
    get: <TArgs extends unknown[], TResult>(
      name: BreakerName,
      action: (...args: TArgs) => Promise<TResult>,
      options: { timeout?: number } = {},
    ) => {
      const existing = breakers.get(name);
      if (existing) return existing as unknown as CircuitBreaker<TArgs, TResult>;

      const breaker = new CircuitBreaker<TArgs, TResult>(action, {
        name,
        timeout: options.timeout ?? env.GATEWAY_TIMEOUT_MS,
        errorThresholdPercentage: env.BREAKER_ERROR_THRESHOLD_PERCENT,
        volumeThreshold: env.BREAKER_VOLUME_THRESHOLD,
        resetTimeout: env.BREAKER_RESET_TIMEOUT_MS,
        rollingCountTimeout: 10000,
        rollingCountBuckets: 10,
      });
      breaker.on('open', () => logger.warn({ breaker: name }, 'circuit breaker opened'));
      breaker.on('halfOpen', () => logger.info({ breaker: name }, 'circuit breaker half-open'));
      breaker.on('close', () => logger.info({ breaker: name }, 'circuit breaker closed'));
      breakers.set(name, breaker as unknown as CircuitBreaker<unknown[], unknown>);
      registerState(name, breaker as unknown as CircuitBreaker<unknown[], unknown>);
      return breaker;
    },
    stateOf: (name: BreakerName) => {
      const breaker = breakers.get(name);
      if (!breaker) return 'closed';
      return breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed';
    },
    states: () => {
      const result: Record<string, string> = {};
      for (const [name, breaker] of breakers.entries()) {
        result[name] = breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed';
      }
      return result;
    },
  };
};
