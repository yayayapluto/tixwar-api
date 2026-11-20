import { describe, expect, it } from 'bun:test';
import type { Collections } from '../../src/infra/db/collections.ts';
import type { PasswordResetTokenDoc, UserDoc } from '../../src/infra/db/types.ts';
import {
  hashPassword,
  requestPasswordReset,
  resetPassword,
  verifyPassword,
} from '../../src/modules/auth/service.ts';
import { forgotPasswordSchema, resetPasswordSchema } from '../../src/modules/schemas.ts';
import { sha256Hex } from '../../src/shared/hash.ts';

interface SentEmail {
  userId: string;
  subject: string;
  body: string;
  requestId: string;
}

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
    updateOne: async (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ): Promise<void> => {
      const row = rows.find((entry) =>
        matches(entry as unknown as Record<string, unknown>, filter),
      );
      if (row) Object.assign(row, update.$set);
    },
    updateMany: async (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ): Promise<void> => {
      for (const row of rows) {
        if (matches(row as unknown as Record<string, unknown>, filter)) {
          Object.assign(row, update.$set);
        }
      }
    },
  };
};

const setup = async () => {
  const passwordHash = await hashPassword('old-password-123');
  const user: UserDoc = {
    _id: 'usr_1',
    email: 'reset-me@example.com',
    passwordHash,
    role: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const users = fakeCollection<UserDoc>([user]);
  const tokens = fakeCollection<PasswordResetTokenDoc>();
  const collections = { users, passwordResetTokens: tokens } as unknown as Collections;
  const sent: SentEmail[] = [];
  const mailer = {
    sendRaw: async (input: SentEmail): Promise<void> => {
      sent.push(input);
    },
  };
  return { user, users, tokens, collections, sent, mailer };
};

const extractToken = (body: string): string => {
  const match = /token=([A-Za-z0-9_-]+)/.exec(body);
  if (!match) throw new Error('no reset token in email body');
  return match[1]!;
};

describe('forgot/reset password', () => {
  it('stores only the token hash and emails the raw token link', async () => {
    const { collections, tokens, sent, mailer } = await setup();
    const result = await requestPasswordReset({
      collections,
      mailer,
      email: 'RESET-ME@Example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    expect(result.emailSent).toBe(true);
    expect(tokens.rows).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userId).toBe('usr_1');
    const rawToken = extractToken(sent[0]!.body);
    expect(sent[0]!.body).toContain('http://localhost:3000/reset-password?token=');
    const stored = tokens.rows[0]!;
    expect(stored.tokenHash).toBe(sha256Hex(rawToken));
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.usedAt).toBeNull();
  });

  it('returns success without storing or sending anything for an unknown email', async () => {
    const { collections, tokens, sent, mailer } = await setup();
    const result = await requestPasswordReset({
      collections,
      mailer,
      email: 'nobody@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    expect(result.emailSent).toBe(false);
    expect(tokens.rows).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('invalidates a previous unused token when a new reset is requested', async () => {
    const { collections, tokens, mailer } = await setup();
    await requestPasswordReset({
      collections,
      mailer,
      email: 'reset-me@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    await requestPasswordReset({
      collections,
      mailer,
      email: 'reset-me@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_2',
    });
    expect(tokens.rows).toHaveLength(2);
    expect(tokens.rows[0]!.usedAt).not.toBeNull();
    expect(tokens.rows[1]!.usedAt).toBeNull();
  });

  it('resets the password and marks the token used', async () => {
    const { user, collections, tokens, sent, mailer } = await setup();
    await requestPasswordReset({
      collections,
      mailer,
      email: 'reset-me@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    const rawToken = extractToken(sent[0]!.body);
    const result = await resetPassword({
      collections,
      token: rawToken,
      password: 'brand-new-password-456',
    });
    expect(result.userId).toBe('usr_1');
    expect(await verifyPassword('brand-new-password-456', user.passwordHash)).toBe(true);
    expect(await verifyPassword('old-password-123', user.passwordHash)).toBe(false);
    expect(tokens.rows[0]!.usedAt).not.toBeNull();
  });

  it('rejects a reused token', async () => {
    const { collections, sent, mailer } = await setup();
    await requestPasswordReset({
      collections,
      mailer,
      email: 'reset-me@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    const rawToken = extractToken(sent[0]!.body);
    await resetPassword({ collections, token: rawToken, password: 'brand-new-password-456' });
    await expect(
      resetPassword({ collections, token: rawToken, password: 'another-password-789' }),
    ).rejects.toThrow('Invalid or expired reset token');
  });

  it('rejects an expired token and an unknown token', async () => {
    const { collections, tokens, sent, mailer } = await setup();
    await requestPasswordReset({
      collections,
      mailer,
      email: 'reset-me@example.com',
      webUrl: 'http://localhost:3000',
      ttlSeconds: 3600,
      requestId: 'req_1',
    });
    const rawToken = extractToken(sent[0]!.body);
    tokens.rows[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(
      resetPassword({ collections, token: rawToken, password: 'brand-new-password-456' }),
    ).rejects.toThrow('Invalid or expired reset token');
    await expect(
      resetPassword({ collections, token: 'never-issued-token', password: 'x'.repeat(10) }),
    ).rejects.toThrow('Invalid or expired reset token');
  });

  it('validates forgot/reset input schemas', () => {
    expect(() => forgotPasswordSchema.parse({ email: 'not-an-email' })).toThrow();
    expect(() => forgotPasswordSchema.parse({ email: 'ok@example.com', extra: 1 })).toThrow();
    expect(() =>
      resetPasswordSchema.parse({ token: 'short', password: 'long-enough-1' }),
    ).toThrow();
    expect(() =>
      resetPasswordSchema.parse({ token: 'long-enough-token', password: 'short' }),
    ).toThrow();
    expect(
      resetPasswordSchema.parse({ token: 'long-enough-token', password: 'long-enough-1' }),
    ).toMatchObject({ token: 'long-enough-token' });
  });
});
