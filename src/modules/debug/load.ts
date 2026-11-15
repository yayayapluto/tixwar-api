import type { AppDeps } from '../../app.ts';
import { newUserId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { badRequest } from '../../shared/problem.ts';
import type { DebugLoadInput } from '../schemas.ts';

const logger = createLogger('debug-load');

export interface LoadSummary {
  scenario: DebugLoadInput['scenario'];
  requests: number;
  concurrency: number;
  succeeded: number;
  failed: number;
  conflicts: number;
  rateLimited: number;
  other: number;
  durationMs: number;
  requestsPerSecond: number;
  p95Ms: number;
  sampleErrors: Array<{ status: number; code: string }>;
}

const percentile = (values: number[], ratio: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)]!;
};

const postOrder = async (input: {
  baseUrl: string;
  token: string;
  tierId: string;
  quantity: number;
  idempotencyKey: string;
}): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${input.baseUrl}/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.token}`,
      'idempotency-key': input.idempotencyKey,
    },
    body: JSON.stringify({ tierId: input.tierId, quantity: input.quantity }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

export const runLoadScenario = async (
  deps: AppDeps,
  input: DebugLoadInput,
  requestId: string,
): Promise<LoadSummary> => {
  if (input.scenario === 'abuse') {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const startedAt = Date.now();
    const responses = await Promise.all(
      Array.from({ length: input.requests }, async () => {
        const response = await fetch(`${deps.selfBaseUrl}/v1/events?limit=5`, {
          headers: { 'x-forwarded-for': ip },
        });
        return response.status;
      }),
    );
    const durationMs = Date.now() - startedAt;
    return {
      scenario: 'abuse',
      requests: input.requests,
      concurrency: input.concurrency,
      succeeded: responses.filter((status) => status === 200).length,
      failed: responses.filter((status) => status >= 500).length,
      conflicts: 0,
      rateLimited: responses.filter((status) => status === 429).length,
      other: responses.filter((status) => status !== 200 && status !== 429 && status < 500).length,
      durationMs,
      requestsPerSecond: Number((input.requests / (durationMs / 1000 || 1)).toFixed(2)),
      p95Ms: 0,
      sampleErrors: [],
    };
  }

  if (!input.tierId) throw badRequest('tierId is required for single and crowd scenarios');
  const tier = await deps.collections.ticketTiers.findOne({ _id: input.tierId });
  if (!tier) throw badRequest('tierId does not exist');

  const userIds: string[] = [];
  if (input.scenario === 'single') {
    if (!input.userId) throw badRequest('userId is required for the single scenario');
    userIds.push(input.userId);
  } else {
    for (let index = 0; index < Math.min(input.requests, 1000); index += 1) {
      userIds.push(newUserId());
    }
  }

  const durations: number[] = [];
  const sampleErrors: Array<{ status: number; code: string }> = [];
  let succeeded = 0;
  let conflicts = 0;
  let rateLimited = 0;
  let failed = 0;
  let other = 0;

  const runOne = async (index: number): Promise<void> => {
    const userId = userIds[index % userIds.length]!;
    const token = await deps.tokens.signAccessToken({ userId, role: 'user' });
    const startedAt = Date.now();
    const response = await postOrder({
      baseUrl: deps.selfBaseUrl,
      token,
      tierId: tier._id,
      quantity: input.quantity,
      idempotencyKey: `debug-${requestId}-${index}`,
    });
    durations.push(Date.now() - startedAt);
    if (response.status === 201) succeeded += 1;
    else if (response.status === 429) rateLimited += 1;
    else if (response.status === 409 || response.status === 403) {
      conflicts += 1;
      if (sampleErrors.length < 5) {
        const body = response.body as { code?: string } | null;
        sampleErrors.push({ status: response.status, code: body?.code ?? 'UNKNOWN' });
      }
    } else if (response.status >= 500) {
      failed += 1;
      if (sampleErrors.length < 5) {
        const body = response.body as { code?: string } | null;
        sampleErrors.push({ status: response.status, code: body?.code ?? 'UNKNOWN' });
      }
    } else {
      other += 1;
    }
  };

  const startedAt = Date.now();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(input.concurrency, input.requests) }, async () => {
    while (cursor < input.requests) {
      const index = cursor;
      cursor += 1;
      await runOne(index);
    }
  });
  await Promise.all(workers);
  const durationMs = Date.now() - startedAt;

  const summary: LoadSummary = {
    scenario: input.scenario,
    requests: input.requests,
    concurrency: input.concurrency,
    succeeded,
    failed,
    conflicts,
    rateLimited,
    other,
    durationMs,
    requestsPerSecond: Number((input.requests / (durationMs / 1000 || 1)).toFixed(2)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    sampleErrors,
  };
  logger.info({ requestId, ...summary }, 'debug load finished');
  return summary;
};
