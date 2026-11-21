import { describe, expect, it } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import type { Collections } from '../../src/infra/db/collections.ts';
import type { ApiKeyDoc, UserDoc } from '../../src/infra/db/types.ts';
import { createAuthMiddleware } from '../../src/middleware/auth.ts';
import { serializeApiKey } from '../../src/modules/apikeys/service.ts';
import type { AccessClaims, TokenService } from '../../src/modules/auth/service.ts';
import { createApiKey } from '../../src/modules/auth/service.ts';
import { sha256Hex } from '../../src/shared/hash.ts';

const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, value]) => doc[key] === value);

const fakeCollection = <T extends { _id: string }>(initial: T[] = []) => {
  const rows: T[] = [...initial];
  const collection = {
    rows,
    updateCalls: [] as { filter: Record<string, unknown>; update: Record<string, unknown> }[],
    failUpdate: false,
    findOne: async (filter: Record<string, unknown>): Promise<T | null> =>
      rows.find((row) => matches(row as unknown as Record<string, unknown>, filter)) ?? null,
    insertOne: async (doc: T): Promise<void> => {
      rows.push(doc);
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ modifiedCount: number }> => {
      collection.updateCalls.push({ filter, update });
      if (collection.failUpdate) throw new Error('db unavailable');
      const row = rows.find((candidate) =>
        matches(candidate as unknown as Record<string, unknown>, filter),
      );
      if (!row) return { modifiedCount: 0 };
      const set = update.$set as Record<string, unknown> | undefined;
      if (set) Object.assign(row, set);
      return { modifiedCount: 1 };
    },
  };
  return collection;
};

const setup = () => {
  const user: UserDoc = {
    _id: 'usr_1',
    email: 'key-owner@example.com',
    passwordHash: 'hashed',
    role: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const users = fakeCollection<UserDoc>([user]);
  const apiKeys = fakeCollection<ApiKeyDoc>();
  const collections = { users, apiKeys } as unknown as Collections;
  const tokens = {
    verifyAccessToken: async (): Promise<AccessClaims> => ({
      sub: 'usr_1',
      role: 'user',
      jti: 'jti_1',
    }),
  } as unknown as TokenService;
  const middleware = createAuthMiddleware({ tokens, collections });
  return { user, users, apiKeys, collections, middleware };
};

const runMiddleware = (
  middleware: ReturnType<typeof createAuthMiddleware>,
  headers: Record<string, string>,
): Promise<{ error: unknown; principal: unknown }> =>
  new Promise((resolve) => {
    const req = {
      header: (name: string): string | undefined => headers[name.toLowerCase()],
    } as unknown as Request;
    const next: NextFunction = (error?: unknown) => {
      resolve({ error, principal: (req as { principal?: unknown }).principal });
    };
    void middleware(req, {} as Response, next);
  });

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('api key last used', () => {
  it('serializes lastUsedAt as an ISO string when set', () => {
    const lastUsedAt = new Date('2026-11-21T06:00:00.000Z');
    const doc = {
      _id: 'key_1',
      ownerId: 'usr_1',
      name: 'used key',
      keyHash: 'abc',
      prefix: 'twk_usedkey',
      active: true,
      createdAt: new Date('2026-11-20T00:00:00.000Z'),
      revokedAt: null,
      expiresAt: null,
      lastUsedAt,
    } as ApiKeyDoc;
    expect(serializeApiKey(doc).lastUsedAt).toBe(lastUsedAt.toISOString());
  });

  it('serializes lastUsedAt as null when unset or missing', () => {
    const fresh = {
      _id: 'key_2',
      ownerId: 'usr_1',
      name: 'fresh key',
      keyHash: 'abc',
      prefix: 'twk_freshkey',
      active: true,
      createdAt: new Date('2026-11-20T00:00:00.000Z'),
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    } as ApiKeyDoc;
    expect(serializeApiKey(fresh).lastUsedAt).toBeNull();

    const legacy = {
      _id: 'key_3',
      ownerId: 'usr_1',
      name: 'legacy',
      keyHash: 'abc',
      prefix: 'twk_legacy',
      active: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    } as ApiKeyDoc;
    expect(serializeApiKey(legacy).lastUsedAt).toBeNull();
  });

  it('stores lastUsedAt null for a newly created key', async () => {
    const { collections, apiKeys } = setup();
    const created = await createApiKey({ collections, ownerId: 'usr_1', name: 'brand new' });
    expect(apiKeys.rows).toHaveLength(1);
    expect(apiKeys.rows[0]!.lastUsedAt).toBeNull();
    expect(serializeApiKey(apiKeys.rows[0]!).lastUsedAt).toBeNull();
    expect(created.id).toBe(apiKeys.rows[0]!._id);
  });

  it('updates lastUsedAt on successful API key authentication', async () => {
    const { apiKeys, middleware } = setup();
    const raw = 'twk_lastused12345678901';
    const before = Date.now();
    await apiKeys.insertOne({
      _id: 'key_1',
      ownerId: 'usr_1',
      name: 'test key',
      keyHash: sha256Hex(raw),
      prefix: raw.slice(0, 12),
      active: true,
      createdAt: new Date(),
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    } as ApiKeyDoc);
    const { error, principal } = await runMiddleware(middleware, { 'x-api-key': raw });
    await flush();
    expect(error).toBeUndefined();
    expect(principal).toMatchObject({ id: 'usr_1', role: 'user', via: 'api-key' });
    expect(apiKeys.updateCalls).toHaveLength(1);
    expect(apiKeys.updateCalls[0]!.filter).toEqual({ _id: 'key_1' });
    const updated = apiKeys.rows[0]!.lastUsedAt;
    expect(updated).toBeInstanceOf(Date);
    expect(updated!.getTime()).toBeGreaterThanOrEqual(before);
    expect(updated!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not update lastUsedAt for JWT authentication', async () => {
    const { apiKeys, middleware } = setup();
    const { error, principal } = await runMiddleware(middleware, {
      authorization: 'Bearer some.jwt.token',
    });
    await flush();
    expect(error).toBeUndefined();
    expect(principal).toMatchObject({ id: 'usr_1', via: 'jwt' });
    expect(apiKeys.updateCalls).toHaveLength(0);
  });

  it('still authenticates when the lastUsedAt update fails', async () => {
    const { apiKeys, middleware } = setup();
    const raw = 'twk_updatefails123456789';
    await apiKeys.insertOne({
      _id: 'key_1',
      ownerId: 'usr_1',
      name: 'test key',
      keyHash: sha256Hex(raw),
      prefix: raw.slice(0, 12),
      active: true,
      createdAt: new Date(),
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    } as ApiKeyDoc);
    apiKeys.failUpdate = true;
    const { error, principal } = await runMiddleware(middleware, { 'x-api-key': raw });
    await flush();
    expect(error).toBeUndefined();
    expect(principal).toMatchObject({ id: 'usr_1', via: 'api-key' });
    expect(apiKeys.rows[0]!.lastUsedAt).toBeNull();
  });
});
