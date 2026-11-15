import type { AppDeps } from '../../app.ts';
import { injectChaos, recoverChaos } from '../../infra/chaos.ts';
import { createLogger } from '../../shared/logger.ts';
import { badRequest } from '../../shared/problem.ts';
import type { DebugChaosInput } from '../schemas.ts';

const logger = createLogger('debug-chaos');

const CHAOS_DURATION_MS = 30_000;

export interface ChaosState {
  target: DebugChaosInput['target'];
  action: DebugChaosInput['action'];
  applied: boolean;
  detail: Record<string, unknown>;
}

const injectTarget = (
  target: 'redis' | 'mongo',
  action: DebugChaosInput['action'],
  value: number | undefined,
): ChaosState => {
  if (action === 'recover') {
    recoverChaos(target);
    return { target, action, applied: true, detail: { recovered: true } };
  }

  const latencyMs = action === 'latency' || action === 'slow' ? (value ?? 3000) : 0;
  const errorRatePercent = action === 'fail' ? (value ?? 100) : 0;
  injectChaos(target, { latencyMs, errorRatePercent, durationMs: CHAOS_DURATION_MS });

  return {
    target,
    action,
    applied: true,
    detail: {
      latencyMs,
      errorRatePercent,
      durationMs: CHAOS_DURATION_MS,
      autoRecoverAfterMs: CHAOS_DURATION_MS,
    },
  };
};

export const applyChaos = async (
  deps: AppDeps,
  input: DebugChaosInput,
  requestId: string,
): Promise<ChaosState> => {
  if (input.target === 'gateway') {
    if (input.action === 'recover') {
      await fetch(`${deps.env.GATEWAY_URL}/toggle-fail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
        signal: AbortSignal.timeout(3000),
      });
      await fetch(`${deps.env.GATEWAY_URL}/latency`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ latencyMs: 0 }),
        signal: AbortSignal.timeout(3000),
      });
      logger.info({ requestId, target: 'gateway', action: 'recover' }, 'chaos recovered');
      return { target: 'gateway', action: 'recover', applied: true, detail: { recovered: true } };
    }

    const endpoint = input.action === 'latency' ? '/latency' : '/toggle-fail';
    const body =
      input.action === 'latency'
        ? { latencyMs: input.value ?? 2000 }
        : { enabled: input.action === 'fail' };
    const response = await fetch(`${deps.env.GATEWAY_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const detail = (await response.json()) as Record<string, unknown>;
    logger.info({ requestId, target: 'gateway', action: input.action }, 'chaos applied');
    return { target: 'gateway', action: input.action, applied: response.ok, detail };
  }

  if (input.target === 'worker') {
    const value = input.action === 'recover' ? 0 : (input.value ?? 100);
    await deps.redis.set('chaos:worker:failure-rate', String(value), 'EX', 3600);
    return {
      target: 'worker',
      action: input.action,
      applied: true,
      detail: { failureRatePercent: value, ttlSeconds: 3600 },
    };
  }

  if (input.target === 'redis') {
    return injectTarget('redis', input.action, input.value);
  }

  if (input.target === 'mongo') {
    return injectTarget('mongo', input.action, input.value);
  }

  throw badRequest('unsupported chaos target');
};
