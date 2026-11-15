import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { pathParam } from '../../shared/request.ts';
import { audit } from '../audit/service.ts';
import { type CreateWebhookInput, createWebhookSchema } from '../schemas.ts';
import type { WebhookService } from './service.ts';

export const createWebhooksRouter = (
  deps: AppDeps,
  service: WebhookService,
  auth: RequestHandler,
): Router => {
  const router = Router();

  router.post('/', auth, validate({ body: createWebhookSchema }), async (req, res, next) => {
    try {
      const body = validated<CreateWebhookInput>(req, 'body');
      const { endpoint, secret } = await service.register({
        ownerId: req.principal!.id,
        url: body.url,
      });
      await audit(deps.collections, {
        userId: req.principal!.id,
        action: 'webhook.create',
        entity: 'webhookEndpoints',
        entityId: endpoint._id,
        diff: { url: endpoint.url },
        requestId: req.requestId,
      });
      res.status(201).json(
        buildEnvelope({
          data: {
            endpoint: {
              id: endpoint._id,
              url: endpoint.url,
              active: endpoint.active,
              createdAt: endpoint.createdAt.toISOString(),
            },
            secret,
            secretShownOnce: true,
          },
          self: '/v1/webhooks/endpoints',
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/endpoints', auth, async (req, res, next) => {
    try {
      const endpoints = await service.list(req.principal!.id);
      res.json(
        buildEnvelope({
          data: endpoints.map((endpoint) => ({
            id: endpoint._id,
            url: endpoint.url,
            active: endpoint.active,
            createdAt: endpoint.createdAt.toISOString(),
          })),
          self: '/v1/webhooks/endpoints',
          limit: endpoints.length,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/endpoints/:id', auth, async (req, res, next) => {
    try {
      await service.deactivate(req.principal!.id, pathParam(req, 'id'));
      await audit(deps.collections, {
        userId: req.principal!.id,
        action: 'webhook.deactivate',
        entity: 'webhookEndpoints',
        entityId: pathParam(req, 'id'),
        diff: { active: false },
        requestId: req.requestId,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
