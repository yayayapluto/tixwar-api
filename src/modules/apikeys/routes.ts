import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { pathParam } from '../../shared/request.ts';
import { audit } from '../audit/service.ts';
import { createApiKey } from '../auth/service.ts';
import { type CreateApiKeyInput, createApiKeySchema } from '../schemas.ts';
import { listApiKeys, revokeApiKey } from './service.ts';

export const createApiKeysRouter = (deps: AppDeps, auth: RequestHandler): Router => {
  const router = Router();

  router.post('/', auth, validate({ body: createApiKeySchema }), async (req, res, next) => {
    try {
      const body = validated<CreateApiKeyInput>(req, 'body');
      const created = await createApiKey({
        collections: deps.collections,
        ownerId: req.principal!.id,
        name: body.name,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      await audit(deps.collections, {
        userId: req.principal!.id,
        action: 'apiKey.create',
        entity: 'apiKeys',
        entityId: created.id,
        diff: { name: body.name, prefix: created.prefix },
        requestId: req.requestId,
      });
      res.status(201).json(
        buildEnvelope({
          data: {
            id: created.id,
            name: body.name,
            prefix: created.prefix,
            apiKey: created.apiKey,
            keyShownOnce: true,
            expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
          },
          self: '/v1/api-keys',
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/', auth, async (req, res, next) => {
    try {
      const keys = await listApiKeys(deps.collections, req.principal!.id, req.principal!.role);
      res.json(buildEnvelope({ data: keys, self: '/v1/api-keys', limit: keys.length }));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', auth, async (req, res, next) => {
    try {
      const keyId = pathParam(req, 'id');
      await revokeApiKey(deps.collections, req.principal!.id, req.principal!.role, keyId);
      await audit(deps.collections, {
        userId: req.principal!.id,
        action: 'apiKey.revoke',
        entity: 'apiKeys',
        entityId: keyId,
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
