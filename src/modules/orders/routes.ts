import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { openSseStream } from '../../debug/sse.ts';
import type { OrderStatus } from '../../infra/db/types.ts';
import { idempotencyKeyOf, ownerIdOf, runIdempotent } from '../../middleware/idempotency.ts';
import { clientIp, userOrIpKey } from '../../middleware/rateLimit.ts';
import { validate, validated } from '../../middleware/validate.ts';
import { buildEnvelope } from '../../shared/http.ts';
import { forbidden, notFound } from '../../shared/problem.ts';
import { pathParam } from '../../shared/request.ts';
import type { EventService } from '../events/service.ts';
import { type OrderService, serializeOrder } from '../orders/service.ts';
import type { PaymentService } from '../payments/service.ts';
import {
  type CancelOrderInput,
  type CreateOrderInput,
  cancelOrderSchema,
  createOrderSchema,
  type OrderListQueryInput,
  orderListQuerySchema,
  payOrderSchema,
} from '../schemas.ts';

export interface OrdersRouterDeps {
  auth: RequestHandler;
  maybeAuth: RequestHandler;
  events: EventService;
  orders: OrderService;
  payments: PaymentService;
}

export const createOrdersRouter = (deps: AppDeps, services: OrdersRouterDeps): Router => {
  const router = Router();

  router.post(
    '/',
    services.auth,
    deps.rateLimiters.middleware('order-user', userOrIpKey),
    deps.rateLimiters.middleware('order-ip', clientIp),
    validate({ body: createOrderSchema }),
    async (req, res, next) => {
      try {
        const body = validated<CreateOrderInput>(req, 'body');
        const userId = ownerIdOf(req);
        const idempotencyKey = idempotencyKeyOf(req);
        const result = await runIdempotent(
          deps.idempotency,
          {
            scope: 'orders.create',
            ownerId: userId,
            key: idempotencyKey,
            payload: { tierId: body.tierId, quantity: body.quantity },
          },
          async () => {
            const order = await services.orders.create({
              userId,
              tierId: body.tierId,
              quantity: body.quantity,
              requestId: req.requestId,
            });
            return { status: 201, data: { order } };
          },
        );
        const order = (result.data as { order: { id: string } }).order;
        res.setHeader('Location', `/v1/orders/${order.id}`);
        res
          .status(result.status)
          .json(buildEnvelope({ data: result.data, self: `/v1/orders/${order.id}`, limit: 1 }));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/',
    services.auth,
    validate({ query: orderListQuerySchema }),
    async (req, res, next) => {
      try {
        const query = validated<OrderListQueryInput>(req, 'query');
        const userId = ownerIdOf(req);
        const result = await services.orders.list({
          userId,
          status: query.status as OrderStatus | undefined,
          limit: query.limit,
          cursor: query.cursor,
        });
        res.json(
          buildEnvelope({
            data: result.data,
            self: '/v1/orders',
            limit: query.limit,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            next: result.nextCursor ? `/v1/orders?cursor=${result.nextCursor}` : null,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/:id', services.auth, async (req, res, next) => {
    try {
      const order = await services.orders.getById(
        pathParam(req, 'id'),
        ownerIdOf(req),
        req.principal!.role,
      );
      res.json(
        buildEnvelope({
          data: { order: serializeOrder(order) },
          self: `/v1/orders/${order._id}`,
          limit: 1,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/stream', services.auth, async (req, res, next) => {
    try {
      const order = await deps.collections.orders.findOne({
        _id: pathParam(req, 'id'),
        deletedAt: null,
      });
      if (!order) throw notFound('Order not found');
      if (order.userId !== ownerIdOf(req) && req.principal!.role !== 'admin') {
        throw forbidden('You do not own this order');
      }
      await openSseStream({
        req,
        res,
        subscriber: deps.subscriber,
        channel: `order:${order._id}`,
        label: 'order',
        lastEventId: req.header('last-event-id'),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/:id/pay',
    services.auth,
    deps.rateLimiters.middleware('pay-user', userOrIpKey),
    validate({ body: payOrderSchema }),
    async (req, res, next) => {
      try {
        const userId = ownerIdOf(req);
        const idempotencyKey = idempotencyKeyOf(req);
        const orderId = pathParam(req, 'id');
        const result = await runIdempotent(
          deps.idempotency,
          { scope: 'orders.pay', ownerId: userId, key: idempotencyKey, payload: { orderId } },
          async () => {
            const outcome = await services.payments.requestPayment({
              orderId,
              userId,
              idempotencyKey,
              requestId: req.requestId,
            });
            return { status: outcome.status === 'QUEUED' ? 202 : 200, data: outcome };
          },
        );
        res
          .status(result.status)
          .json(buildEnvelope({ data: result.data, self: `/v1/orders/${orderId}/pay`, limit: 1 }));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:id/cancel',
    services.auth,
    validate({ body: cancelOrderSchema }),
    async (req, res, next) => {
      try {
        const body = validated<CancelOrderInput>(req, 'body');
        const order = await services.orders.cancel(
          pathParam(req, 'id'),
          ownerIdOf(req),
          req.requestId,
        );
        res.json(
          buildEnvelope({
            data: { order, reason: body?.reason ?? null },
            self: `/v1/orders/${order.id}`,
            limit: 1,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
