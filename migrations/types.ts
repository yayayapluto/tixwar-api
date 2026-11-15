import type { Db } from 'mongodb';

export interface MigrationStep {
  id: string;
  description: string;
  up: (db: Db) => Promise<void>;
}

export const collectionExists = async (db: Db, name: string): Promise<boolean> => {
  const collections = await db.listCollections({ name }).toArray();
  return collections.length > 0;
};

export const createCollectionIfMissing = async (
  db: Db,
  name: string,
  options: Record<string, unknown> = {},
): Promise<void> => {
  if (await collectionExists(db, name)) return;
  await db.createCollection(name, options);
};
