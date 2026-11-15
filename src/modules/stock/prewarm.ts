import type { Container } from '../../bootstrap.ts';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('stock-prewarm');

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const prewarmDueTiers = async (container: Container): Promise<string[]> => {
  const windowStart = new Date();
  const windowEnd = new Date(
    windowStart.getTime() + container.env.STOCK_PREWARM_MINUTES * 60 * 1000,
  );
  const tiers = await container.collections.ticketTiers
    .find({ saleStartsAt: { $lte: windowEnd }, saleEndsAt: { $gt: windowStart } })
    .toArray();

  const warmed: string[] = [];
  for (const tier of tiers) {
    try {
      const existing = await container.stock.getStock(tier._id);
      if (existing !== null) continue;
      const activeOrders = await container.collections.orders
        .find(
          {
            tierId: tier._id,
            status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED', 'PAID', 'CONFIRMED'] },
            deletedAt: null,
          },
          { projection: { quantity: 1 } },
        )
        .toArray();
      const reserved = activeOrders.reduce((total, order) => total + order.quantity, 0);
      const remaining = Math.max(0, tier.quota - reserved);
      await container.stock.prewarm(tier._id, remaining);
      warmed.push(tier._id);
      logger.info({ tierId: tier._id, remaining }, 'stock prewarmed');
    } catch (error) {
      logger.error({ err: error, tierId: tier._id }, 'prewarm failed');
    }
  }
  return warmed;
};

export const startPrewarmLoop = (
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
        await prewarmDueTiers(container);
      } catch (error) {
        logger.error({ err: error }, 'prewarm loop error');
      }
      await sleep(30_000);
    }
  };
  void loop();
  return stop;
};
