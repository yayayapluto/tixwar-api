import type { Db } from 'mongodb';
import type { MigrationStep } from './types.ts';

export const createPasswordResetTokensMigration: MigrationStep = {
  id: '005-password-reset-tokens',
  description: 'Create passwordResetTokens collection with unique token hash and TTL on expiry',
  up: async (db: Db) => {
    const existing = await db.listCollections({ name: 'passwordResetTokens' }).toArray();
    if (existing.length === 0) {
      await db.createCollection('passwordResetTokens');
    }
    await db
      .collection('passwordResetTokens')
      .createIndex({ tokenHash: 1 }, { name: 'uniq_token_hash', unique: true });
    await db.collection('passwordResetTokens').createIndex({ userId: 1 }, { name: 'user_id' });
    await db
      .collection('passwordResetTokens')
      .createIndex({ expiresAt: 1 }, { name: 'ttl_expires_at', expireAfterSeconds: 0 });
  },
};
