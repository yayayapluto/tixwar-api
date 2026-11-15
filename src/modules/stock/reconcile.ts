import type { Container } from '../../bootstrap.ts';
import { metrics } from '../../infra/metrics/registry.ts';
import { createLogger } from '../../shared/logger.ts';
import { isTerminal } from '../orders/state.ts';

const logger = createLogger('stock-reconcile');

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export interface ReconcileSummary {
  tierId: string;
  redisStock: number;
  durableStock: number;
  drift: number;
  action: 'none' | 'rewritten';
}

export const computeDurableStock = async (
  container: Container,
  tierId: string,
  quota: number,
): Promise<number> => {
  const orders = await container.collections.orders
    .find(
      {
        tierId,
        status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED', 'PAID', 'CONFIRMED'] },
        deletedAt: null,
      },
      { projection: { quantity: 1 } },
    )
    .toArray();
  const reserved = orders.reduce((total, order) => total + order.quantity, 0);
  return Math.max(0, quota - reserved);
};

export const reconcileTier = async (
  container: Container,
  tier: { _id: string; quota: number },
): Promise<ReconcileSummary> => {
  const redisStock = await container.stock.getStock(tier._id);
  const durableStock = await computeDurableStock(container, tier._id, tier.quota);
  if (redisStock === null) {
    await container.stock.prewarm(tier._id, durableStock);
    return { tierId: tier._id, redisStock: -1, durableStock, drift: 0, action: 'rewritten' };
  }
  const drift = redisStock - durableStock;
  metrics.stockReconcileDrift.set({ tier: tier._id }, Math.abs(drift));
  if (drift === 0) {
    return { tierId: tier._id, redisStock, durableStock, drift: 0, action: 'none' };
  }
  await container.stock.setStock(tier._id, durableStock);
  logger.warn({ tierId: tier._id, redisStock, durableStock, drift }, 'stock drift corrected');
  return { tierId: tier._id, redisStock, durableStock, drift, action: 'rewritten' };
};

export const reconcileAll = async (container: Container): Promise<ReconcileSummary[]> => {
  const tiers = await container.collections.ticketTiers
    .find({ saleEndsAt: { $gt: new Date(Date.now() - 3600_000) } })
    .toArray();
  const summaries: ReconcileSummary[] = [];
  for (const tier of tiers) {
    try {
      summaries.push(await reconcileTier(container, { _id: tier._id, quota: tier.quota }));
    } catch (error) {
      logger.error({ err: error, tierId: tier._id }, 'reconcile failed for tier');
      metrics.stockReconcileRuns.inc({ result: 'error' });
    }
  }
  metrics.stockReconcileRuns.inc({ result: 'ok' });
  return summaries;
};

export const startReconcileLoop = (
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
        await reconcileAll(container);
      } catch (error) {
        logger.error({ err: error }, 'reconcile loop error');
      }
      await sleep(container.env.STOCK_RECONCILE_SECONDS * 1000);
    }
  };

  void loop();
  return stop;
};

export const countActiveOrders = async (container: Container, tierId: string): Promise<number> => {
  const orders = await container.collections.orders
    .find({ tierId, deletedAt: null }, { projection: { status: 1 } })
    .toArray();
  return orders.filter((order) => !isTerminal(order.status)).length;
};
