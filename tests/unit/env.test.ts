import { describe, expect, it } from 'bun:test';
import { parseEnv, resetEnvCache } from '../../src/config/env.ts';

const baseEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://mongos:27017/tixwar',
  REDIS_URL: 'redis://redis:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  GATEWAY_URL: 'http://mock-gateway:4000',
});

describe('env validation', () => {
  it('parses durations and byte limits into numbers', () => {
    const env = parseEnv({
      ...baseEnv(),
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7d',
      BODY_LIMIT: '100kb',
    });
    expect(env.JWT_ACCESS_TTL).toBe(900);
    expect(env.JWT_REFRESH_TTL).toBe(604800);
    expect(env.BODY_LIMIT).toBe(102400);
  });

  it('applies documented defaults', () => {
    const env = parseEnv(baseEnv());
    expect(env.PORT).toBe(3000);
    expect(env.ORDER_TTL_SECONDS).toBe(600);
    expect(env.STOCK_RECONCILE_SECONDS).toBe(60);
    expect(env.MONGODB_READ_PREFERENCE).toBe('primary');
    expect(env.RATE_LIMIT_ORDER_USER).toBe(3);
    expect(env.DEBUG_ENABLED).toBe(false);
  });

  it('rejects missing required secrets', () => {
    const env = baseEnv();
    delete env.JWT_ACCESS_SECRET;
    expect(() => parseEnv(env)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects short secrets', () => {
    expect(() => parseEnv({ ...baseEnv(), JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 16/);
  });

  it('requires DEBUG_ADMIN_TOKEN when debug is enabled', () => {
    expect(() => parseEnv({ ...baseEnv(), DEBUG_ENABLED: 'true' })).toThrow(/DEBUG_ADMIN_TOKEN/);
    const ok = parseEnv({
      ...baseEnv(),
      DEBUG_ENABLED: 'true',
      DEBUG_ADMIN_TOKEN: 'token-0123456789',
    });
    expect(ok.DEBUG_ENABLED).toBe(true);
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      parseEnv({
        ...baseEnv(),
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'replace-with-long-random-secret',
        JWT_REFRESH_SECRET: 'replace-with-another-long-random-secret',
      }),
    ).toThrow(/placeholder/);
  });

  it('rejects invalid enum values and malformed durations', () => {
    expect(() => parseEnv({ ...baseEnv(), MONGODB_READ_PREFERENCE: 'anywhere' })).toThrow();
    expect(() => parseEnv({ ...baseEnv(), JWT_ACCESS_TTL: '15 minutes' })).toThrow(/s\|m\|h\|d/);
  });

  it('rejects a min pool size larger than the max pool size', () => {
    expect(() =>
      parseEnv({ ...baseEnv(), MONGODB_MIN_POOL_SIZE: '100', MONGODB_MAX_POOL_SIZE: '10' }),
    ).toThrow(/MIN_POOL_SIZE/);
  });

  it('never caches a failed parse', () => {
    resetEnvCache();
    expect(() => parseEnv({ ...baseEnv(), REDIS_URL: '' })).toThrow();
  });
});
