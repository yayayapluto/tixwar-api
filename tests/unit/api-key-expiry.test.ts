import { describe, expect, it } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import type { Collections } from '../../src/infra/db/collections.ts';
import type { ApiKeyDoc, UserDoc } from '../../src/infra/db/types.ts';
import { createAuthMiddleware } from '../../src/middleware/auth.ts';
import { serializeApiKey } from '../../src/modules/apikeys/service.ts';
import type { TokenService } from '../../src/modules/auth/service.ts';
import { createApiKey } from '../../src/modules/auth/service.ts';
import { createApiKeySchema } from '../../src/modules/schemas.ts';
import { sha256Hex } from '../../src/shared/hash.ts';
import { AppError } from '../../src/shared/problem.ts';

const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, value]) => doc[key] === value);

const fakeCollection = <T extends { _id: string }>(initial: T[] = []) => {
  const rows: T[] = [...initial];
  return {
    rows,
    findOne: async (filter: Record<string, unknown>): Promise<T | null> =>
      rows.find((row) => matches(row as unknown as Record<string, unknown>, filter)) ?? null,
    insertOne: async (doc: T): Promise<void> => {
      rows.push(doc);
    },
  };
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
    verifyAccessToken: async (): Promise<never> => {
      throw new Error('no bearer token in these tests');
    },
  } as unknown as TokenService;
  const middleware = createAuthMiddleware({ tokens, collections });
  return { user, users, apiKeys, collections, middleware };
};

const runMiddleware = (
  middleware: ReturnType<typeof createAuthMiddleware>,
  apiKey: string,
): Promise<{ error: unknown; principal: unknown }> =>
  new Promise((resolve) => {
    const req = {
      header: (name: string): string | undefined => {
        if (name.toLowerCase() === 'x-api-key') return apiKey;
        return undefined;
      },
    } as unknown as Request;
    const next: NextFunction = (error?: unknown) => {
      resolve({ error, principal: (req as { principal?: unknown }).principal });
    };
    void middleware(req, {} as Response, next);
  });

const insertKey = async (
  apiKeys: ReturnType<typeof fakeCollection<ApiKeyDoc>>,
  raw: string,
  expiresAt?: Date | null,
): Promise<void> => {
  await apiKeys.insertOne({
    _id: 'key_1',
    ownerId: 'usr_1',
    name: 'test key',
    keyHash: sha256Hex(raw),
    prefix: raw.slice(0, 12),
    active: true,
    createdAt: new Date(),
    revokedAt: null,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  } as ApiKeyDoc);
};

describe('api key expiry', () => {
  it('stores the expiry date when create is given one', async () => {
    const { collections, apiKeys } = setup();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const created = await createApiKey({
      collections,
      ownerId: 'usr_1',
      name: 'short-lived',
      expiresAt,
    });
    expect(apiKeys.rows).toHaveLength(1);
    expect(apiKeys.rows[0]!.expiresAt).toEqual(expiresAt);
    expect(created.expiresAt).toEqual(expiresAt);
    expect(serializeApiKey(apiKeys.rows[0]!).expiresAt).toBe(expiresAt.toISOString());
  });

  it('stores null expiry when create is given none', async () => {
    const { collections, apiKeys } = setup();
    const created = await createApiKey({ collections, ownerId: 'usr_1', name: 'forever' });
    expect(apiKeys.rows[0]!.expiresAt).toBeNull();
    expect(created.expiresAt).toBeNull();
    expect(serializeApiKey(apiKeys.rows[0]!).expiresAt).toBeNull();
  });

  it('serializes a legacy key without an expiresAt field as null', () => {
    const legacy = {
      _id: 'key_old',
      ownerId: 'usr_1',
      name: 'legacy',
      keyHash: 'abc',
      prefix: 'twk_legacy',
      active: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    } as ApiKeyDoc;
    expect(serializeApiKey(legacy).expiresAt).toBeNull();
  });

  it('rejects a past or current expiresAt in the create schema', () => {
    expect(() =>
      createApiKeySchema.parse({
        name: 'too late',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).toThrow('expiresAt must be a date in the future');
    expect(() =>
      createApiKeySchema.parse({ name: 'now', expiresAt: new Date().toISOString() }),
    ).toThrow('expiresAt must be a date in the future');
    expect(() =>
      createApiKeySchema.parse({ name: 'bad format', expiresAt: 'tomorrow-ish' }),
    ).toThrow();
    expect(
      createApiKeySchema.parse({
        name: 'future',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ).toMatchObject({ name: 'future' });
    expect(createApiKeySchema.parse({ name: 'no expiry' })).toEqual({ name: 'no expiry' });
  });

  it('rejects an expired key at authentication with 401', async () => {
    const { apiKeys, middleware } = setup();
    const raw = 'twk_expiredkey1234567890';
    await insertKey(apiKeys, raw, new Date(Date.now() - 1000));
    const { error, principal } = await runMiddleware(middleware, raw);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(401);
    expect((error as AppError).message).toBe('API key has expired');
    expect(principal).toBeUndefined();
  });

  it('accepts a key that has not expired yet', async () => {
    const { middleware, apiKeys } = setup();
    const raw = 'twk_validkey123456789012';
    await insertKey(apiKeys, raw, new Date(Date.now() + 3600_000));
    const { error, principal } = await runMiddleware(middleware, raw);
    expect(error).toBeUndefined();
    expect(principal).toMatchObject({ id: 'usr_1', role: 'user', via: 'api-key' });
  });

  it('accepts a key without expiry, including a legacy key missing the field', async () => {
    const { middleware, apiKeys } = setup();
    const rawNoExpiry = 'twk_noexpiry12345678901';
    await insertKey(apiKeys, rawNoExpiry, null);
    const first = await runMiddleware(middleware, rawNoExpiry);
    expect(first.error).toBeUndefined();
    expect(first.principal).toMatchObject({ id: 'usr_1', via: 'api-key' });

    const rawLegacy = 'twk_legacykey1234567890';
    await insertKey(apiKeys, rawLegacy);
    const second = await runMiddleware(middleware, rawLegacy);
    expect(second.error).toBeUndefined();
    expect(second.principal).toMatchObject({ id: 'usr_1', via: 'api-key' });
  });
});
