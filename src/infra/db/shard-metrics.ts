import type { Container } from '../../bootstrap.ts';
import { createLogger } from '../../shared/logger.ts';
import { metrics } from '../metrics/registry.ts';
import {
  collectReplicaStatus,
  collectServerConnections,
  collectShardDistribution,
  listShards,
} from './client.ts';
import { SHARDED_COLLECTIONS } from './collections.ts';

const logger = createLogger('shard-metrics');

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const collectShardMetrics = async (container: Container): Promise<void> => {
  const distribution = await collectShardDistribution(container.mongo.db, [...SHARDED_COLLECTIONS]);
  for (const entry of distribution) {
    metrics.mongodbShardDocuments.set(
      { collection: entry.collection, shard: entry.shard },
      entry.count,
    );
  }

  const connections = await collectServerConnections(container.mongo.db);
  for (const [state, value] of Object.entries(connections)) {
    metrics.mongodbServerConnections.set({ state }, value);
  }

  const members = await collectReplicaStatus(container.mongo.db);
  for (const member of members) {
    metrics.replicaSetMemberState.set({ set: member.set, member: member.member }, member.state);
    metrics.replicaHealthGauge.set({ set: member.set }, member.healthy ? 1 : 0);
  }

  const shards = await listShards(container.mongo.db);
  logger.debug({ shards, entries: distribution.length }, 'shard metrics collected');
};

export const startShardMetricsLoop = (
  container: Container,
  signal: AbortSignal,
): (() => Promise<void>) => {
  let stopped = false;
  const stop = async (): Promise<void> => {
    stopped = true;
  };
  const loop = async (): Promise<void> => {
    while (!signal.aborted && !stopped) {
      try {
        await collectShardMetrics(container);
      } catch (error) {
        logger.debug({ err: error }, 'shard metrics collection failed');
      }
      await sleep(15_000);
    }
  };
  void loop();
  return stop;
};
