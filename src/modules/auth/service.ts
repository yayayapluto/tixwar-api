import { randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '../../config/env.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { UserRole } from '../../infra/db/types.ts';
import { sha256Hex } from '../../shared/hash.ts';
import { newUserId } from '../../shared/ids.ts';
import { conflict, unauthorized } from '../../shared/problem.ts';

export interface AccessClaims {
  sub: string;
  role: UserRole;
  jti: string;
}

export interface RefreshClaims {
  sub: string;
  family: string;
  jti: string;
}

const ACCESS_AUDIENCE = 'tixwar:access';
const REFRESH_AUDIENCE = 'tixwar:refresh';

export class TokenService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshSecret: Uint8Array;
  private readonly env: Env;
  private readonly collections: Collections;

  constructor(env: Env, collections: Collections) {
    this.env = env;
    this.accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
    this.collections = collections;
  }

  async signAccessToken(input: { userId: string; role: UserRole }): Promise<string> {
    return new SignJWT({ role: input.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.env.JWT_ACCESS_TTL)
      .sign(this.accessSecret);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret, {
        issuer: this.env.JWT_ISSUER,
        audience: ACCESS_AUDIENCE,
      });
      if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
        throw unauthorized('Access token payload is malformed');
      }
      const role = payload.role === 'admin' ? 'admin' : 'user';
      return { sub: payload.sub, role, jti: payload.jti };
    } catch {
      throw unauthorized('Access token is invalid or expired');
    }
  }

  async issueRefreshToken(input: { userId: string; family?: string }): Promise<string> {
    const family = input.family ?? randomUUID();
    const token = await new SignJWT({ family })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(REFRESH_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.env.JWT_REFRESH_TTL)
      .sign(this.refreshSecret);

    await this.collections.refreshTokens.insertOne({
      _id: randomUUID(),
      userId: input.userId,
      tokenHash: sha256Hex(token),
      family,
      expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL * 1000),
      createdAt: new Date(),
      revokedAt: null,
      replacedBy: null,
    });

    return token;
  }

  async verifyRefreshToken(token: string): Promise<RefreshClaims> {
    try {
      const { payload } = await jwtVerify(token, this.refreshSecret, {
        issuer: this.env.JWT_ISSUER,
        audience: REFRESH_AUDIENCE,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.family !== 'string'
      ) {
        throw unauthorized('Refresh token payload is malformed');
      }
      return { sub: payload.sub, family: payload.family, jti: payload.jti };
    } catch {
      throw unauthorized('Refresh token is invalid or expired');
    }
  }

  async rotateRefreshToken(token: string): Promise<{ userId: string; refreshToken: string }> {
    const claims = await this.verifyRefreshToken(token);
    const hash = sha256Hex(token);
    const stored = await this.collections.refreshTokens.findOne({ tokenHash: hash });

    if (!stored) throw unauthorized('Refresh token is not recognized');

    if (stored.revokedAt !== null) {
      await this.collections.refreshTokens.updateMany(
        { userId: stored.userId, family: stored.family, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      throw unauthorized('Refresh token reuse detected; token family revoked');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw unauthorized('Refresh token has expired');
    }

    const nextToken = await this.issueRefreshToken({
      userId: claims.sub,
      family: stored.family,
    });
    await this.collections.refreshTokens.updateOne(
      { _id: stored._id },
      { $set: { revokedAt: new Date(), replacedBy: sha256Hex(nextToken) } },
    );

    return { userId: claims.sub, refreshToken: nextToken };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const hash = sha256Hex(token);
    await this.collections.refreshTokens.updateOne(
      { tokenHash: hash, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.collections.refreshTokens.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }
}

export const hashPassword = async (password: string): Promise<string> => {
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const createUser = async (input: {
  collections: Collections;
  email: string;
  password: string;
  role?: UserRole;
}): Promise<{ id: string; email: string; role: UserRole }> => {
  const email = normalizeEmail(input.email);
  const existing = await input.collections.users.findOne({ email });
  if (existing) throw conflict('CONFLICT', 'Email Already Registered', 'Email is already in use');

  const now = new Date();
  const doc = {
    _id: newUserId(),
    email,
    passwordHash: await hashPassword(input.password),
    role: input.role ?? ('user' as UserRole),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await input.collections.users.insertOne(doc);
  return { id: doc._id, email: doc.email, role: doc.role };
};

export const createApiKey = async (input: {
  collections: Collections;
  ownerId: string;
  name: string;
}): Promise<{ id: string; apiKey: string; prefix: string }> => {
  const raw = `twk_${randomBytes(24).toString('base64url')}`;
  const prefix = raw.slice(0, 12);
  const doc = {
    _id: randomUUID(),
    ownerId: input.ownerId,
    name: input.name,
    keyHash: sha256Hex(raw),
    prefix,
    active: true,
    createdAt: new Date(),
    revokedAt: null,
  };
  await input.collections.apiKeys.insertOne(doc);
  return { id: doc._id, apiKey: raw, prefix };
};
