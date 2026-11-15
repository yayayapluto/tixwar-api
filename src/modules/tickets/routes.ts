import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { pathParam } from '../../shared/request.ts';
import { type TicketListQueryInput, ticketListQuerySchema } from '../schemas.ts';
import { serializeTicket, type TicketService } from './service.ts';

export const createTicketsRouter = (
  deps: AppDeps,
  service: TicketService,
  auth: RequestHandler,
): Router => {
  const router = Router();

  router.get('/', auth, validate({ query: ticketListQuerySchema }), async (req, res, next) => {
    try {
      const query = validated<TicketListQueryInput>(req, 'query');
      const result = await service.list({
        userId: req.principal!.id,
        limit: query.limit,
        cursor: query.cursor,
      });
      res.json(
        buildEnvelope({
          data: result.data,
          self: '/v1/tickets',
          limit: query.limit,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          next: result.nextCursor ? `/v1/tickets?cursor=${result.nextCursor}` : null,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', auth, async (req, res, next) => {
    try {
      const { ticket, qrUrl } = await service.getById(
        pathParam(req, 'id'),
        req.principal!.id,
        req.principal!.role,
      );
      res.json(
        buildEnvelope({
          data: {
            ticket: serializeTicket(ticket),
            qrUrl,
            qrExpiresIn: deps.env.MINIO_PRESIGN_TTL_SECONDS,
          },
          self: `/v1/tickets/${ticket._id}`,
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
};
