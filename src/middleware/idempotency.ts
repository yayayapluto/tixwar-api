import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { Collections } from '../infra/db/collections.ts';
import { metrics } from '../infra/metrics/registry.ts';
import { hashRequest } from '../shared/hash.ts';
import {
  badRequest,
  idempotencyConflict,
  idempotencyInProgress,
  unauthorized,
} from '../shared/problem.ts';

const TTL_SECONDS = 86400;

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export class IdempotencyStore {
  private readonly collections: Collections;
  private readonly redis: Redis;

  constructor(collections: Collections, redis: Redis) {
    this.collections = collections;
    this.redis = redis;
  }

  async claim(input: {
    scope: string;
    ownerId: string;
    key: string;
    payload: unknown;
  }): Promise<
    | { state: 'acquired'; requestHash: string }
    | { state: 'replay'; response: StoredResponse }
    | { state: 'conflict' }
    | { state: 'in-progress' }
  > {
    const requestHash = hashRequest(input.payload);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_SECONDS * 1000);

    const existing = await this.collections.idempotencyKeys.findOne({
      scope: input.scope,
      ownerId: input.ownerId,
      key: input.key,
    });

    if (existing) {
      if (existing.expiresAt.getTime() <= now.getTime()) {
        await this.collections.idempotencyKeys.deleteOne({ _id: existing._id });
      } else if (existing.requestHash !== requestHash) {
        metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'conflict' });
        return { state: 'conflict' };
      } else if (existing.status === 'COMPLETED' && existing.response) {
        metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'replay' });
        return { state: 'replay', response: existing.response as StoredResponse };
      } else {
        metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'in-progress' });
        return { state: 'in-progress' };
      }
    }

    try {
      await this.collections.idempotencyKeys.insertOne({
        _id: randomUUID(),
        scope: input.scope,
        ownerId: input.ownerId,
        key: input.key,
        requestHash,
        response: null,
        status: 'IN_PROGRESS',
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'acquired' });
      return { state: 'acquired', requestHash };
    } catch (error) {
      const isDuplicate =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: number }).code === 11000;
      if (!isDuplicate) throw error;
      const raced = await this.collections.idempotencyKeys.findOne({
        scope: input.scope,
        ownerId: input.ownerId,
        key: input.key,
      });
      if (raced?.requestHash !== requestHash) {
        metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'conflict' });
        return { state: 'conflict' };
      }
      if (raced?.status === 'COMPLETED' && raced.response) {
        metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'replay' });
        return { state: 'replay', response: raced.response as StoredResponse };
      }
      metrics.idempotencyOutcomes.inc({ scope: input.scope, outcome: 'in-progress' });
      return { state: 'in-progress' };
    }
  }

  async complete(input: {
    scope: string;
    ownerId: string;
    key: string;
    response: StoredResponse;
  }): Promise<void> {
    await this.collections.idempotencyKeys.updateOne(
      { scope: input.scope, ownerId: input.ownerId, key: input.key },
      {
        $set: {
          status: 'COMPLETED',
          response: input.response,
          updatedAt: new Date(),
        },
      },
    );
    await this.redis.del(this.inflightKey(input));
  }

  async abort(input: { scope: string; ownerId: string; key: string }): Promise<void> {
    await this.collections.idempotencyKeys.deleteOne({
      scope: input.scope,
      ownerId: input.ownerId,
      key: input.key,
    });
    await this.redis.del(this.inflightKey(input));
  }

  private inflightKey(input: { scope: string; ownerId: string; key: string }): string {
    return `idem:${input.scope}:${input.ownerId}:${input.key}`;
  }
}

export const idempotencyKeyOf = (req: Request): string => {
  const key = req.header('idempotency-key');
  if (!key) throw badRequest('Idempotency-Key header is required');
  if (key.length < 8 || key.length > 200) {
    throw badRequest('Idempotency-Key must be between 8 and 200 characters');
  }
  return key;
};

export const ownerIdOf = (req: Request): string => {
  if (!req.principal) throw unauthorized('Authentication required');
  return req.principal.id;
};

export interface IdempotentResult<T> {
  status: number;
  data: T;
}

export type IdempotentHandler<T> = () => Promise<IdempotentResult<T>>;

export const runIdempotent = async <T>(
  store: IdempotencyStore,
  input: { scope: string; ownerId: string; key: string; payload: unknown },
  handler: IdempotentHandler<T>,
): Promise<IdempotentResult<T>> => {
  const claim = await store.claim(input);
  if (claim.state === 'replay') {
    return { status: claim.response.status, data: claim.response.body as T };
  }
  if (claim.state === 'conflict') {
    throw idempotencyConflict('Idempotency-Key was reused with a different request payload');
  }
  if (claim.state === 'in-progress') {
    throw idempotencyInProgress('A request with this Idempotency-Key is still in progress');
  }

  try {
    const result = await handler();
    await store.complete({
      scope: input.scope,
      ownerId: input.ownerId,
      key: input.key,
      response: { status: result.status, body: result.data },
    });
    return result;
  } catch (error) {
    await store.abort(input);
    throw error;
  }
};
