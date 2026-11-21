import { Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { openSseStream } from '../../debug/sse.ts';
import { featureEnabled } from '../../infra/feature-flags.ts';
import { requireRole } from '../../middleware/auth.ts';
import { clientIp } from '../../middleware/rateLimit.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { badRequest, dependencyUnavailable, notFound } from '../../shared/problem.ts';
import { pathParam } from '../../shared/request.ts';
import { audit } from '../audit/service.ts';
import { EventStatsService } from '../eventstats/service.ts';
import {
  type BulkTiersInput,
  bulkTiersSchema,
  type CreateEventInput,
  createEventSchema,
  eventListQueryGuard,
  eventListQuerySchema,
  type PatchEventInput,
  patchEventSchema,
} from '../schemas.ts';
import { parseEventSortMode } from './query.ts';
import type { EventService } from './service.ts';

export const createEventsRouter = (deps: AppDeps, service: EventService): Router => {
  const router = Router();
  const stats = new EventStatsService(deps.collections);

  router.get(
    '/',
    deps.rateLimiters.middleware('anon-browse', clientIp),
    validate({ query: eventListQueryGuard }),
    async (req, res, next) => {
      try {
        const rawQuery = { ...(req.query as Record<string, unknown>) };
        const sortMode = parseEventSortMode(rawQuery.sort);
        delete rawQuery.sort;
        const query = eventListQuerySchema.parse(rawQuery);
        const queryParams = { ...(req.query as Record<string, string>), sort: sortMode };
        const selfPath = `/v1/events?${new URLSearchParams(
          Object.entries(queryParams).filter(([key]) => key !== 'cursor'),
        ).toString()}`;
        const result = await service.list({ ...query, sort: sortMode }, selfPath);
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('X-Cache', result.cacheHit ? 'HIT' : 'MISS');
        const nextCursor = result.nextCursor;
        res.json(
          buildEnvelope({
            data: result.data,
            self: selfPath,
            limit: result.limit,
            page: result.page,
            total: result.total,
            nextCursor,
            hasMore: result.hasMore,
            next: nextCursor
              ? `/v1/events?${new URLSearchParams({ ...queryParams, cursor: nextCursor, page: '' }).toString()}`
              : null,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/:id', async (req, res, next) => {
    try {
      const include = typeof req.query.include === 'string' ? req.query.include.split(',') : [];
      if (include.length > 0 && !include.every((value) => value === 'tiers')) {
        throw badRequest('include only supports "tiers"');
      }
      const result = await service.getById(pathParam(req, 'id'), {
        include,
        ifNoneMatch: req.header('if-none-match') ?? undefined,
      });
      res.setHeader('ETag', result.etag);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      if (result.notModified) {
        res.status(304).end();
        return;
      }
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/stream', async (req, res, next) => {
    try {
      if (!(await featureEnabled(deps.redis, 'sse_enabled'))) {
        throw dependencyUnavailable('SSE is disabled by feature flag');
      }
      const event = await deps.collections.events.findOne({
        _id: pathParam(req, 'id'),
        deletedAt: null,
      });
      if (!event) throw notFound('Event not found');
      await openSseStream({
        req,
        res,
        subscriber: deps.subscriber,
        channel: `stock:${event._id}`,
        label: 'stock',
        lastEventId: req.header('last-event-id'),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/stats', async (req, res, next) => {
    try {
      const result = await stats.get(pathParam(req, 'id'));
      res.json(
        buildEnvelope({
          data: result,
          self: `/v1/events/${result.eventId}/stats`,
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/',
    requireRole('admin'),
    validate({ body: createEventSchema }),
    async (req, res, next) => {
      try {
        const body = validated<CreateEventInput>(req, 'body');
        const doc = await service.create(body, req.principal!.id);
        await audit(deps.collections, {
          userId: req.principal!.id,
          action: 'event.create',
          entity: 'events',
          entityId: doc._id,
          diff: { name: doc.name, status: doc.status },
          requestId: req.requestId,
        });
        res.status(201).json(
          buildEnvelope({
            data: { id: doc._id, name: doc.name, status: doc.status },
            self: `/v1/events/${doc._id}`,
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/:id',
    requireRole('admin'),
    validate({ body: patchEventSchema }),
    async (req, res, next) => {
      try {
        const body = validated<PatchEventInput>(req, 'body');
        const before = await service.getById(pathParam(req, 'id'));
        const doc = await service.patch(pathParam(req, 'id'), body);
        await audit(deps.collections, {
          userId: req.principal!.id,
          action: 'event.update',
          entity: 'events',
          entityId: doc._id,
          diff: { before: before.body.data, after: body },
          requestId: req.requestId,
        });
        res.json(
          buildEnvelope({
            data: { id: doc._id, name: doc.name, status: doc.status, updatedAt: doc.updatedAt },
            self: `/v1/events/${doc._id}`,
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete('/:id', requireRole('admin'), async (req, res, next) => {
    try {
      await service.softDelete(pathParam(req, 'id'));
      await audit(deps.collections, {
        userId: req.principal!.id,
        action: 'event.delete',
        entity: 'events',
        entityId: pathParam(req, 'id'),
        diff: { softDeleted: true },
        requestId: req.requestId,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/:id/tiers/bulk',
    requireRole('admin'),
    validate({ body: bulkTiersSchema }),
    async (req, res, next) => {
      try {
        const body = validated<BulkTiersInput>(req, 'body');
        const result = await service.bulkCreateTiers(pathParam(req, 'id'), body.tiers);
        await audit(deps.collections, {
          userId: req.principal!.id,
          action: 'tier.bulk_create',
          entity: 'ticketTiers',
          entityId: pathParam(req, 'id'),
          diff: { inserted: result.inserted, ids: result.ids },
          requestId: req.requestId,
        });
        res.status(201).json(
          buildEnvelope({
            data: { inserted: result.inserted, ids: result.ids },
            self: `/v1/events/${req.params.id}/tiers`,
            limit: result.inserted,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
