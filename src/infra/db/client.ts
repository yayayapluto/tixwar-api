import {
  type ClientSession,
  type Db,
  type Document,
  MongoClient,
  type MongoClientOptions,
  type ReadPreference,
  ReadPreference as ReadPreferenceEnum,
} from 'mongodb';
import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';
import { metrics } from '../metrics/registry.ts';

const logger = createLogger('mongo');

export interface MongoContext {
  client: MongoClient;
  db: Db;
  readDb: Db;
  close: () => Promise<void>;
}

const readPreferenceFromEnv = (value: Env['MONGODB_READ_PREFERENCE']): ReadPreference =>
  value === 'primary'
    ? ReadPreferenceEnum.primary
    : value === 'primaryPreferred'
      ? ReadPreferenceEnum.primaryPreferred
      : value === 'secondary'
        ? ReadPreferenceEnum.secondary
        : value === 'secondaryPreferred'
          ? ReadPreferenceEnum.secondaryPreferred
          : ReadPreferenceEnum.nearest;

const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite']);
const MONITORED_COMMANDS = new Set([
  'find',
  'insert',
  'update',
  'delete',
  'aggregate',
  'count',
  'distinct',
  'findAndModify',
  'getMore',
  'createIndexes',
]);

interface PendingCommand {
  collection: string;
  operation: string;
  startedAt: bigint;
}

const attachCommandMonitoring = (client: MongoClient): void => {
  const pending = new Map<number, PendingCommand>();

  client.on('commandStarted', (event) => {
    if (!MONITORED_COMMANDS.has(event.commandName)) return;
    const collection =
      typeof event.command[event.commandName] === 'string'
        ? (event.command[event.commandName] as string)
        : 'unknown';
    pending.set(event.requestId, {
      collection,
      operation: event.commandName,
      startedAt: process.hrtime.bigint(),
    });
  });

  const record = (requestId: number, result: 'success' | 'failure'): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    const seconds = Number(process.hrtime.bigint() - entry.startedAt) / 1e9;
    metrics.mongodbOperationsTotal.inc({
      collection: entry.collection,
      operation: entry.operation,
      result,
    });
    metrics.mongodbOperationDuration.observe(
      { collection: entry.collection, operation: entry.operation },
      seconds,
    );
  };

  client.on('commandSucceeded', (event) => record(event.requestId, 'success'));
  client.on('commandFailed', (event) => record(event.requestId, 'failure'));
};

export const createMongoClient = (env: Env, uri = env.MONGODB_URI): MongoClient => {
  const options: MongoClientOptions = {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    minPoolSize: env.MONGODB_MIN_POOL_SIZE,
    maxConnecting: env.MONGODB_MAX_CONNECTING,
    waitQueueTimeoutMS: env.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
    serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: env.MONGODB_SOCKET_TIMEOUT_MS,
    connectTimeoutMS: env.MONGODB_CONNECT_TIMEOUT_MS,
    readPreference: readPreferenceFromEnv(env.MONGODB_READ_PREFERENCE),
    writeConcern: { w: env.MONGODB_WRITE_CONCERN === 'majority' ? 'majority' : 1 },
    retryWrites: true,
    retryReads: true,
    monitorCommands: true,
    appName: env.SERVICE_NAME,
  };
  const client = new MongoClient(uri, options);
  attachCommandMonitoring(client);
  return client;
};

export const connectMongo = async (env: Env): Promise<MongoContext> => {
  const client = createMongoClient(env);
  await client.connect();
  const db = client.db(env.MONGODB_DATABASE);
  const readDb = client.db(env.MONGODB_DATABASE, {
    readPreference: readPreferenceFromEnv(env.MONGODB_READ_PREFERENCE),
  });
  logger.info({ database: env.MONGODB_DATABASE }, 'mongo connected');
  return {
    client,
    db,
    readDb,
    close: async () => {
      await client.close();
    },
  };
};

export const isWriteCommand = (commandName: string): boolean => WRITE_COMMANDS.has(commandName);

const TRANSIENT_ERROR_LABELS = ['TransientTransactionError'];
const UNKNOWN_COMMIT_RESULT_LABELS = ['UnknownTransactionCommitResult'];

const hasLabel = (error: unknown, label: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const labels = (error as { errorLabels?: string[] }).errorLabels;
  return Array.isArray(labels) && labels.includes(label);
};

export const runInTransaction = async <T>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<T>,
  options: { maxAttempts?: number } = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    const session = client.startSession();
    try {
      let result: T;
      await session.withTransaction(
        async () => {
          result = await work(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
      return result!;
    } catch (error) {
      if (attempt < maxAttempts && hasLabel(error, TRANSIENT_ERROR_LABELS[0])) {
        logger.warn({ attempt, err: error }, 'retrying transient transaction');
        continue;
      }
      if (hasLabel(error, UNKNOWN_COMMIT_RESULT_LABELS[0])) {
        logger.error({ err: error }, 'unknown transaction commit result');
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
};

export const pingMongo = async (client: MongoClient): Promise<boolean> => {
  try {
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'mongo ping failed');
    return false;
  }
};

export interface ShardDistributionEntry {
  collection: string;
  shard: string;
  count: number;
}

export const collectShardDistribution = async (
  db: Db,
  collections: string[],
): Promise<ShardDistributionEntry[]> => {
  const entries: ShardDistributionEntry[] = [];
  for (const collection of collections) {
    try {
      const stats = await db
        .collection(collection)
        .aggregate<{ shard: string; count: number }>([
          { $collStats: { storageStats: {} } },
          { $group: { _id: '$shard', count: { $sum: '$storageStats.count' } } },
          { $project: { _id: 0, shard: '$_id', count: 1 } },
        ])
        .toArray();
      for (const entry of stats) {
        if (!entry.shard) continue;
        entries.push({ collection, shard: entry.shard, count: entry.count });
      }
    } catch (error) {
      logger.debug({ err: error, collection }, 'shard distribution unavailable for collection');
    }
  }
  return entries;
};

export const collectServerConnections = async (db: Db): Promise<Record<string, number>> => {
  try {
    const status: Document = await db.admin().command({ serverStatus: 1 });
    const connections =
      typeof status.connections === 'object' && status.connections !== null
        ? (status.connections as Document)
        : {};
    return {
      current: Number(connections.current ?? 0),
      available: Number(connections.available ?? 0),
      totalCreated: Number(connections.totalCreated ?? 0),
    };
  } catch (error) {
    logger.debug({ err: error }, 'serverStatus unavailable');
    return {};
  }
};

export interface ReplicaMemberStatus {
  set: string;
  member: string;
  state: number;
  healthy: boolean;
}

export const collectReplicaStatus = async (db: Db): Promise<ReplicaMemberStatus[]> => {
  try {
    const result: Document = await db.admin().command({ replSetGetStatus: 1 });
    const setName = typeof result.set === 'string' ? result.set : 'unknown';
    const members = Array.isArray(result.members) ? (result.members as Document[]) : [];
    return members.map((member) => ({
      set: setName,
      member: String(member.name ?? 'unknown'),
      state: Number(member.state ?? 0),
      healthy: Number(member.health ?? 0) === 1,
    }));
  } catch {
    return [];
  }
};

export const listShards = async (db: Db): Promise<string[]> => {
  try {
    const result: Document = await db.admin().command({ listShards: 1 });
    const shards = Array.isArray(result.shards) ? (result.shards as Document[]) : [];
    return shards.map((shard) => String(shard._id ?? 'unknown'));
  } catch {
    return [];
  }
};

export const getCollectionShardKey = async (
  db: Db,
  collection: string,
): Promise<Document | null> => {
  const entry = await db.client
    .db('config')
    .collection<{ _id: string; key?: Document; dropped?: boolean }>('collections')
    .findOne({ _id: `${db.databaseName}.${collection}`, dropped: { $ne: true } });
  const key = entry?.key;
  return typeof key === 'object' && key !== null ? (key as Document) : null;
};
