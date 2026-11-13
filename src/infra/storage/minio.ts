import { Client } from 'minio';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('storage');

export interface StorageContext {
  client: Client;
  bucket: string;
  ensureBucket: () => Promise<void>;
  presignedGet: (objectKey: string) => Promise<string>;
}

export const connectStorage = async (env: Env): Promise<StorageContext> => {
  const client = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });

  const ensureBucket = async (): Promise<void> => {
    try {
      const exists = await client.bucketExists(env.MINIO_BUCKET);
      if (!exists) {
        await client.makeBucket(env.MINIO_BUCKET);
        logger.info({ bucket: env.MINIO_BUCKET }, 'bucket created');
      }
    } catch (error) {
      logger.warn({ err: error }, 'bucket check failed');
    }
  };

  return {
    client,
    bucket: env.MINIO_BUCKET,
    ensureBucket,
    presignedGet: async (objectKey: string) =>
      client.presignedGetObject(env.MINIO_BUCKET, objectKey, env.MINIO_PRESIGN_TTL_SECONDS),
  };
};

export const isStorageAvailable = async (storage: StorageContext): Promise<boolean> => {
  try {
    return await storage.client.bucketExists(storage.bucket);
  } catch {
    return false;
  }
};
