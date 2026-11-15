import { Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { pingMongo } from '../../infra/db/client.ts';
import { renderMetrics } from '../../infra/metrics/registry.ts';
import { QUEUE_NAMES, queueDepthFor } from '../../infra/queue/queues.ts';
import { pingRedis } from '../../infra/redis/client.ts';
import { isStorageAvailable } from '../../infra/storage/minio.ts';

export const createHealthRouter = (deps: AppDeps): Router => {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: deps.env.SERVICE_NAME,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      breakers: deps.breakers.states(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (_req, res) => {
    const [mongo, redis, storage] = await Promise.all([
      pingMongo(deps.client),
      pingRedis(deps.redis),
      isStorageAvailable(deps.storage),
    ]);
    const queues: Record<string, number> = {};
    for (const [name, queue] of Object.entries(deps.queues.queues)) {
      try {
        queues[name] = await queueDepthFor(queue);
      } catch {
        queues[name] = -1;
      }
    }
    const critical = mongo && redis;
    res.status(critical ? 200 : 503).json({
      status: critical ? 'ready' : 'degraded',
      checks: { mongodb: mongo, redis, storage, queues },
      breakers: deps.breakers.states(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/metrics', async (_req, res, next) => {
    try {
      const body = await renderMetrics();
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/health/queues', async (_req, res) => {
    const depths: Record<string, number> = {};
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = deps.queues.queues[name];
      depths[name] = queue ? await queueDepthFor(queue) : -1;
    }
    res.json({ queues: depths });
  });

  return router;
};
