import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { openSseStream } from '../../debug/sse.ts';
import { requireDebugAccess } from '../../middleware/auth.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { pathParam } from '../../shared/request.ts';
import {
  type DebugChaosInput,
  type DebugLoadInput,
  debugChaosSchema,
  debugLoadSchema,
} from '../schemas.ts';
import { applyChaos, getChaosState } from './chaos.ts';
import { runLoadScenario } from './load.ts';

export const createDebugRouter = (deps: AppDeps, auth: RequestHandler): Router => {
  const router = Router();
  const guard = [
    auth,
    requireDebugAccess({
      debugEnabled: deps.env.DEBUG_ENABLED,
      debugToken: deps.env.DEBUG_ADMIN_TOKEN,
    }),
  ];

  router.get('/stream', ...guard, async (req, res, next) => {
    try {
      await openSseStream({
        req,
        res,
        subscriber: deps.subscriber,
        channel: deps.trace.channel,
        label: 'trace',
        lastEventId: req.header('last-event-id'),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/load', ...guard, validate({ body: debugLoadSchema }), async (req, res, next) => {
    try {
      const body = validated<DebugLoadInput>(req, 'body');
      const summary = await runLoadScenario(deps, body, req.requestId);
      res.json(buildEnvelope({ data: summary, self: '/debug/load', limit: 1 }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/chaos', ...guard, async (_req, res, next) => {
    try {
      const state = await getChaosState(deps);
      res.json(buildEnvelope({ data: state, self: '/debug/chaos', limit: 1 }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/chaos', ...guard, validate({ body: debugChaosSchema }), async (req, res, next) => {
    try {
      const body = validated<DebugChaosInput>(req, 'body');
      const state = await applyChaos(deps, body, req.requestId);
      res.json(buildEnvelope({ data: state, self: '/debug/chaos', limit: 1 }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/traces/:requestId', ...guard, async (req, res, next) => {
    try {
      const traces = await deps.collections.requestTraces
        .find({ 'meta.requestId': pathParam(req, 'requestId') })
        .sort({ ts: 1 })
        .limit(200)
        .toArray();
      res.json(
        buildEnvelope({
          data: traces.map((trace) => ({
            ts: trace.ts.toISOString(),
            step: trace.step,
            status: trace.status,
            durationMs: trace.durationMs,
            payload: trace.payload,
          })),
          self: `/debug/traces/${pathParam(req, 'requestId')}`,
          limit: traces.length,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
};
