import './infra/tracing.ts';
import './infra/sentry.ts';
import { createApp } from './app.ts';
import { createContainer } from './bootstrap.ts';
import { getEnv } from './config/env.ts';
import { startShardMetricsLoop } from './infra/db/shard-metrics.ts';
import { stopTracing } from './infra/tracing.ts';
import { startPrewarmLoop } from './modules/stock/prewarm.ts';
import { startReconcileLoop } from './modules/stock/reconcile.ts';
import { createLogger } from './shared/logger.ts';

const logger = createLogger('server');

const main = async (): Promise<void> => {
  const env = getEnv();
  const container = await createContainer(env);
  const app = createApp(container);

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, service: env.SERVICE_NAME }, 'api listening');
  });

  const abort = new AbortController();
  const stopReconcile = startReconcileLoop(container, abort.signal);
  const stopPrewarm = startPrewarmLoop(container, abort.signal);
  const stopShardMetrics = startShardMetricsLoop(container, abort.signal);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown started');
    abort.abort();
    await Promise.allSettled([stopReconcile(), stopPrewarm(), stopShardMetrics()]);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 10000);
    });
    await container.shutdown();
    await stopTracing();
    logger.info('graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
  });
};

await main();
