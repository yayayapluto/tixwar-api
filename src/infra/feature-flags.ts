import type { Redis } from 'ioredis';

export type FeatureFlag = 'sse_enabled' | 'payment_retry_enabled';

const FLAG_KEY: Record<FeatureFlag, string> = {
  sse_enabled: 'feature:sse_enabled',
  payment_retry_enabled: 'feature:payment_retry_enabled',
};

const DEFAULTS: Record<FeatureFlag, boolean> = {
  sse_enabled: true,
  payment_retry_enabled: true,
};

export const featureEnabled = async (redis: Redis, flag: FeatureFlag): Promise<boolean> => {
  try {
    const value = await redis.get(FLAG_KEY[flag]);
    if (value === null) return DEFAULTS[flag];
    return value === 'true' || value === '1';
  } catch {
    return DEFAULTS[flag];
  }
};

export const setFeature = async (
  redis: Redis,
  flag: FeatureFlag,
  enabled: boolean,
): Promise<void> => {
  await redis.set(FLAG_KEY[flag], enabled ? 'true' : 'false');
};
