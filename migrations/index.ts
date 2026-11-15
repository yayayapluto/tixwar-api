import type { Env } from '../src/config/env.ts';
import { createCollectionsMigration } from './001-init-collections.ts';
import { createIndexesMigration } from './002-indexes.ts';
import { createJsonSchemaValidationMigration } from './003-json-schema-validation.ts';
import { createShardCollectionsMigration } from './004-shard-collections.ts';
import type { MigrationStep } from './types.ts';

export const buildMigrations = (env: Env): MigrationStep[] => [
  createCollectionsMigration(env),
  createIndexesMigration,
  createJsonSchemaValidationMigration,
  createShardCollectionsMigration,
];

export type { MigrationStep } from './types.ts';
