import { getEnv } from '../src/config/env.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { getCollections } from '../src/infra/db/collections.ts';
import { connectRedis } from '../src/infra/redis/client.ts';
import { StockGate } from '../src/infra/redis/stock.ts';

const LOCK_KEY = 'maintenance:rebuild-stock';

const main = async (): Promise<void> => {
  const env = getEnv();
  const dryRun = !process.argv.includes('--apply');
  const mongo = await connectMongo(env);
  const redisCtx = await connectRedis(env);
  const collections = getCollections(mongo.db);
  const stock = new StockGate(redisCtx.client);

  try {
    const tiers = await collections.ticketTiers.find({}).sort({ _id: 1 }).toArray();
    const plan: Array<{
      tierId: string;
      eventId: string;
      quota: number;
      currentStock: number | null;
      durableStock: number;
    }> = [];

    for (const tier of tiers) {
      const orders = await collections.orders
        .find(
          {
            tierId: tier._id,
            status: { $in: ['PENDING_PAYMENT', 'PAYMENT_QUEUED', 'PAID', 'CONFIRMED'] },
            deletedAt: null,
          },
          { projection: { quantity: 1 } },
        )
        .toArray();
      const reserved = orders.reduce((total, order) => total + order.quantity, 0);
      const durableStock = Math.max(0, tier.quota - reserved);
      plan.push({
        tierId: tier._id,
        eventId: tier.eventId,
        quota: tier.quota,
        currentStock: await stock.getStock(tier._id),
        durableStock,
      });
    }

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            hint: 'pass --apply to rewrite Redis stock from MongoDB',
            tiers: plan,
          },
          null,
          2,
        ),
      );
      return;
    }

    const locked = await redisCtx.client.set(LOCK_KEY, '1', 'PX', 60000, 'NX');
    if (locked !== 'OK') {
      throw new Error('rebuild refused: maintenance lock is held by another process');
    }

    try {
      for (const entry of plan) {
        await stock.setStock(entry.tierId, entry.durableStock);
        let cursor = '0';
        do {
          const [next, keys] = await redisCtx.client.scan(
            cursor,
            'MATCH',
            `reserved:${entry.eventId}:*`,
            'COUNT',
            200,
          );
          cursor = next;
          if (keys.length > 0) await redisCtx.client.del(...keys);
        } while (cursor !== '0');
      }
      console.log(
        JSON.stringify({ mode: 'applied', rewritten: plan.length, tiers: plan }, null, 2),
      );
    } finally {
      await redisCtx.client.del(LOCK_KEY);
    }
  } finally {
    await redisCtx.close();
    await mongo.close();
  }
};

await main();
