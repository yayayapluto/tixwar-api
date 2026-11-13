import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createApiKey } from '../../src/modules/auth/service.ts';
import { sha256Hex } from '../../src/shared/hash.ts';
import { getHarness, type Harness, jsonRequest, resetDatabase } from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
  await resetDatabase(harness.container);
});

afterAll(async () => {
  await harness.stop();
});

const register = async (email: string, password = 'Strong-Password-2024') =>
  jsonRequest(harness.baseUrl, 'POST', '/v1/auth/register', {
    body: { email, password },
  });

describe('auth flow', () => {
  it('registers a user with argon2id hash and never returns the hash', async () => {
    const result = await register('flow-register@tixwar.local');
    expect(result.status).toBe(201);
    const body = result.body as {
      data: {
        user: { id: string; email: string; role: string };
        accessToken: string;
        refreshToken: string;
      };
    };
    expect(body.data.user.role).toBe('user');
    expect(body.data.accessToken.length).toBeGreaterThan(50);
    expect(JSON.stringify(result.body)).not.toContain('passwordHash');

    const stored = await harness.container.collections.users.findOne({
      email: 'flow-register@tixwar.local',
    });
    expect(stored?.passwordHash).toContain('$argon2');
    expect(stored?.passwordHash).not.toContain('Strong-Password-2024');
  }, 30_000);

  it('rejects duplicate registration with 409', async () => {
    await register('flow-duplicate@tixwar.local');
    const duplicate = await register('flow-duplicate@tixwar.local');
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code: string }).code).toBe('CONFLICT');
  }, 30_000);

  it('logs in and rejects a wrong password', async () => {
    await register('flow-login@tixwar.local');
    const ok = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/login', {
      body: { email: 'flow-login@tixwar.local', password: 'Strong-Password-2024' },
    });
    expect(ok.status).toBe(200);
    const bad = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/login', {
      body: { email: 'flow-login@tixwar.local', password: 'wrong-password' },
    });
    expect(bad.status).toBe(401);
  }, 30_000);

  it('rotates refresh tokens and detects reuse by revoking the family', async () => {
    const created = await register('flow-refresh@tixwar.local');
    const original = (created.body as { data: { refreshToken: string } }).data.refreshToken;

    const first = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: original },
    });
    expect(first.status).toBe(200);
    const rotated = (first.body as { data: { refreshToken: string } }).data.refreshToken;
    expect(rotated).not.toBe(original);

    const reuse = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: original },
    });
    expect(reuse.status).toBe(401);
    expect((reuse.body as { detail: string }).detail).toContain('reuse detected');

    const familyRevoked = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: rotated },
    });
    expect(familyRevoked.status).toBe(401);
  }, 30_000);

  it('revokes a refresh token on logout', async () => {
    const created = await register('flow-logout@tixwar.local');
    const refreshToken = (created.body as { data: { refreshToken: string } }).data.refreshToken;
    const accessToken = (created.body as { data: { accessToken: string } }).data.accessToken;

    const logout = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/logout', {
      body: { refreshToken },
      token: accessToken,
    });
    expect(logout.status).toBe(204);

    const afterLogout = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refreshToken },
    });
    expect(afterLogout.status).toBe(401);
  }, 30_000);

  it('enforces RBAC on admin routes', async () => {
    const user = await register('flow-rbac@tixwar.local');
    const token = (user.body as { data: { accessToken: string } }).data.accessToken;

    const forbidden = await jsonRequest(harness.baseUrl, 'POST', '/v1/events', {
      token,
      body: {
        name: 'RBAC Event',
        category: 'music',
        city: 'jakarta',
        venue: 'Hall',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { code: string }).code).toBe('FORBIDDEN');
  }, 30_000);

  it('accepts an API key and rejects a revoked one', async () => {
    const user = await register('flow-apikey@tixwar.local');
    const userId = (user.body as { data: { user: { id: string } } }).data.user.id;
    const created = await createApiKey({
      collections: harness.container.collections,
      ownerId: userId,
      name: 'integration',
    });

    const withKey = await jsonRequest(harness.baseUrl, 'GET', '/v1/orders', {
      headers: { 'x-api-key': created.apiKey },
    });
    expect(withKey.status).toBe(200);

    await harness.container.collections.apiKeys.updateOne(
      { _id: created.id },
      { $set: { active: false, revokedAt: new Date() } },
    );
    const revoked = await jsonRequest(harness.baseUrl, 'GET', '/v1/orders', {
      headers: { 'x-api-key': created.apiKey },
    });
    expect(revoked.status).toBe(401);

    const stored = await harness.container.collections.apiKeys.findOne({ _id: created.id });
    expect(stored?.keyHash).toBe(sha256Hex(created.apiKey));
    expect(stored?.keyHash).not.toBe(created.apiKey);
  }, 30_000);

  it('locks an account after repeated failed logins', async () => {
    await register('flow-lockout@tixwar.local');
    const failures = harness.container.env.RATE_LIMIT_LOGIN_LOCKOUT_FAILURES;
    for (let attempt = 0; attempt < failures; attempt += 1) {
      await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/login', {
        body: { email: 'flow-lockout@tixwar.local', password: `wrong-${attempt}` },
      });
    }
    const locked = await jsonRequest(harness.baseUrl, 'POST', '/v1/auth/login', {
      body: { email: 'flow-lockout@tixwar.local', password: 'Strong-Password-2024' },
    });
    expect(locked.status).toBe(401);
    expect((locked.body as { detail: string }).detail).toContain('locked');
  }, 60_000);

  it('rejects an expired or tampered access token', async () => {
    const user = await register('flow-token@tixwar.local');
    const token = (user.body as { data: { accessToken: string } }).data.accessToken;
    const tampered = `${token.slice(0, -4)}abcd`;

    const response = await jsonRequest(harness.baseUrl, 'GET', '/v1/orders', {
      token: tampered,
    });
    expect(response.status).toBe(401);
  }, 30_000);
});
