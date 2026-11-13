import type { AppDeps } from '../../app.ts';
import { createLogger } from '../../shared/logger.ts';
import { badRequest } from '../../shared/problem.ts';
import type { DebugChaosInput } from '../schemas.ts';

const logger = createLogger('debug-chaos');

export interface ChaosState {
  target: DebugChaosInput['target'];
  action: DebugChaosInput['action'];
  applied: boolean;
  detail: Record<string, unknown>;
}

export const applyChaos = async (
  deps: AppDeps,
  input: DebugChaosInput,
  requestId: string,
): Promise<ChaosState> => {
  if (input.target === 'gateway') {
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
    const value = input.value ?? 100;
    await deps.redis.set('chaos:worker:failure-rate', String(value), 'EX', 3600);
    return {
      target: 'worker',
      action: input.action,
      applied: true,
      detail: { failureRatePercent: value, ttlSeconds: 3600 },
    };
  }

  if (input.target === 'redis') {
    const value = input.value ?? 3000;
    await deps.redis.set('chaos:redis:latency-ms', String(value), 'EX', 3600);
    return {
      target: 'redis',
      action: input.action,
      applied: true,
      detail: {
        latencyMs: value,
        note: 'informational only; redis latency is not injected in-process',
      },
    };
  }

  if (input.target === 'mongo') {
    const value = input.value ?? 1000;
    await deps.redis.set('chaos:mongo:slow-ms', String(value), 'EX', 3600);
    return {
      target: 'mongo',
      action: input.action,
      applied: true,
      detail: { slowMs: value, note: 'read by debug instrumentation only' },
    };
  }

  throw badRequest('unsupported chaos target');
};

export const workerFailureRate = async (deps: AppDeps): Promise<number> => {
  const value = await deps.redis.get('chaos:worker:failure-rate');
  return value ? Number(value) : 0;
};
