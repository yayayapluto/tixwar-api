import type { Collections } from '../../infra/db/collections.ts';
import type { ApiKeyDoc } from '../../infra/db/types.ts';
import { forbidden, notFound } from '../../shared/problem.ts';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export const serializeApiKey = (doc: ApiKeyDoc): ApiKeyView => ({
  id: doc._id,
  name: doc.name,
  prefix: doc.prefix,
  active: doc.active,
  createdAt: doc.createdAt.toISOString(),
  revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
});

export const listApiKeys = async (
  collections: Collections,
  ownerId: string,
  role: 'user' | 'admin',
): Promise<ApiKeyView[]> => {
  const filter = role === 'admin' ? {} : { ownerId };
  const docs = await collections.apiKeys.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
  return docs.map(serializeApiKey);
};

export const revokeApiKey = async (
  collections: Collections,
  ownerId: string,
  role: 'user' | 'admin',
  keyId: string,
): Promise<void> => {
  const doc = await collections.apiKeys.findOne({ _id: keyId });
  if (!doc) throw notFound('API key not found');
  if (role !== 'admin' && doc.ownerId !== ownerId) throw forbidden('You do not own this API key');

  const result = await collections.apiKeys.updateOne(
    { _id: keyId, active: true },
    { $set: { active: false, revokedAt: new Date() } },
  );
  if (result.modifiedCount === 0) throw notFound('API key not found or already revoked');
};
