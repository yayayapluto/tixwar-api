import { createContainer } from './bootstrap.ts';
import { getEnv } from './config/env.ts';
import { runPublisherLoop } from './events/publisher.ts';
import { createLogger } from './shared/logger.ts';

const logger = createLogger('outbox-publisher-entry');

const main = async (): Promise<void> => {
  const env = getEnv();
  const container = await createContainer(env);
  const abort = new AbortController();

  logger.info({ intervalMs: env.OUTBOX_POLL_INTERVAL_MS }, 'outbox publisher started');
  const loop = runPublisherLoop(
    { env, collections: container.collections, queues: container.queues },
    abort.signal,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'outbox publisher draining');
    abort.abort();
    await loop;
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await loop;
};

await main();
