import { afterEach, describe, expect, it } from 'bun:test';
import type { AppDeps } from '../../src/app.ts';
import { injectChaos, recoverChaos } from '../../src/infra/chaos.ts';
import { getChaosState } from '../../src/modules/debug/chaos.ts';

const buildDeps = (input: {
  workerRate: string | null;
  workerTtl: number;
  gatewayUrl?: string;
}): AppDeps =>
  ({
    redis: {
      get: async () => input.workerRate,
      ttl: async () => input.workerTtl,
    },
    env: { GATEWAY_URL: input.gatewayUrl ?? 'http://127.0.0.1:1' },
  }) as unknown as AppDeps;

afterEach(() => {
  recoverChaos('redis');
  recoverChaos('mongo');
});

describe('getChaosState', () => {
  it('reports injected redis latency and mongo fail as active', async () => {
    injectChaos('redis', { latencyMs: 500, errorRatePercent: 0, durationMs: 30_000 });
    injectChaos('mongo', { latencyMs: 0, errorRatePercent: 100, durationMs: 30_000 });
    const state = await getChaosState(buildDeps({ workerRate: null, workerTtl: -2 }));

    const redis = state.targets.find((target) => target.target === 'redis');
    expect(redis).toMatchObject({
      active: true,
      action: 'latency',
      detail: { latencyMs: 500, errorRatePercent: 0 },
    });
    expect(redis?.detail.remainingMs).toBeGreaterThan(0);
    expect(redis?.detail.remainingMs).toBeLessThanOrEqual(30_000);

    expect(state.targets.find((target) => target.target === 'mongo')).toMatchObject({
      active: true,
      action: 'fail',
      detail: { latencyMs: 0, errorRatePercent: 100 },
    });
  });

  it('reports redis and mongo as inactive after recover', async () => {
    injectChaos('redis', { latencyMs: 500, errorRatePercent: 0, durationMs: 30_000 });
    injectChaos('mongo', { latencyMs: 0, errorRatePercent: 100, durationMs: 30_000 });
    recoverChaos('redis');
    recoverChaos('mongo');
    const state = await getChaosState(buildDeps({ workerRate: null, workerTtl: -2 }));

    expect(state.targets.find((target) => target.target === 'redis')).toMatchObject({
      active: false,
      action: null,
      detail: {},
    });
    expect(state.targets.find((target) => target.target === 'mongo')).toMatchObject({
      active: false,
      action: null,
      detail: {},
    });
  });

  it('reports worker as inactive when the key is absent', async () => {
    const state = await getChaosState(buildDeps({ workerRate: null, workerTtl: -2 }));
    expect(state.targets.find((target) => target.target === 'worker')).toMatchObject({
      active: false,
      action: null,
      detail: { failureRatePercent: 0 },
    });
  });

  it('reports worker as active with rate and ttl when the key exists', async () => {
    const state = await getChaosState(buildDeps({ workerRate: '50', workerTtl: 3599 }));
    expect(state.targets.find((target) => target.target === 'worker')).toMatchObject({
      active: true,
      action: 'fail',
      detail: { failureRatePercent: 50, ttlSeconds: 3599 },
    });
  });

  it('reports worker as inactive when the key holds zero', async () => {
    const state = await getChaosState(buildDeps({ workerRate: '0', workerTtl: 3600 }));
    expect(state.targets.find((target) => target.target === 'worker')).toMatchObject({
      active: false,
      action: null,
    });
  });

  it('reports gateway as unreachable instead of throwing', async () => {
    const state = await getChaosState(buildDeps({ workerRate: null, workerTtl: -2 }));
    expect(state.targets.find((target) => target.target === 'gateway')).toMatchObject({
      active: false,
      action: null,
      detail: { reachable: false },
    });
  });

  it('returns all four targets in a fixed order', async () => {
    const state = await getChaosState(buildDeps({ workerRate: null, workerTtl: -2 }));
    expect(state.targets.map((target) => target.target)).toEqual([
      'redis',
      'mongo',
      'worker',
      'gateway',
    ]);
  });
});
