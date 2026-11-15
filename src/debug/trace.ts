import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';
import { metrics } from '../infra/metrics/registry.ts';
import { createLogger } from '../shared/logger.ts';

const logger = createLogger('trace');

export interface TraceEvent {
  requestId: string;
  ts: string;
  node: string;
  step: string;
  status: 'ok' | 'error' | 'skip';
  durationMs: number;
  meta?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /token|secret|password|authorization|apikey|email/i;

const sanitizeValue = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}...`;
    return value;
  }
  if (Array.isArray(value))
    return value.slice(0, 10).map((entry) => sanitizeValue(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : sanitizeValue(entry, depth + 1);
  }
  return result;
};

export interface TraceContext {
  redis: Redis;
  db: Db;
  channel: string;
  enabled: boolean;
  emit: (event: Omit<TraceEvent, 'ts'> & { ts?: string }) => Promise<void>;
  record: (event: Omit<TraceEvent, 'ts'> & { ts?: string }) => Promise<void>;
}

export const createTraceContext = (input: {
  redis: Redis;
  db: Db;
  channel: string;
  enabled: boolean;
}): TraceContext => {
  const publish = async (event: Omit<TraceEvent, 'ts'> & { ts?: string }): Promise<void> => {
    if (!input.enabled) return;
    const payload: TraceEvent = {
      ...event,
      ts: event.ts ?? new Date().toISOString(),
      meta: event.meta ? (sanitizeValue(event.meta) as Record<string, unknown>) : undefined,
    };
    metrics.traceEventsTotal.inc({ step: payload.step, status: payload.status });
    try {
      await input.redis.publish(input.channel, JSON.stringify(payload));
    } catch (error) {
      logger.debug({ err: error }, 'trace publish failed');
    }
  };

  const record = async (event: Omit<TraceEvent, 'ts'> & { ts?: string }): Promise<void> => {
    await publish(event);
    if (!input.enabled) return;
    try {
      await input.db.collection('requestTraces').insertOne({
        ts: new Date(event.ts ?? Date.now()),
        meta: {
          node: event.node,
          service: 'tixwar',
          requestId: event.requestId,
        },
        step: event.step,
        status: event.status,
        durationMs: event.durationMs,
        payload: event.meta ? (sanitizeValue(event.meta) as Record<string, unknown>) : {},
      });
    } catch (error) {
      logger.debug({ err: error }, 'trace persistence failed');
    }
  };

  return {
    redis: input.redis,
    db: input.db,
    channel: input.channel,
    enabled: input.enabled,
    emit: publish,
    record,
  };
};

export const sanitizeTrace = sanitizeValue;
