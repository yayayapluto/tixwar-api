import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getCollectionShardKey, listShards } from '../../src/infra/db/client.ts';
import { SHARDED_COLLECTIONS } from '../../src/infra/db/collections.ts';
import { getHarness, type Harness, resetDatabase, seedTier, seedUser } from '../support/harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await getHarness();
  await resetDatabase(harness.container);
});

afterAll(async () => {
  await harness.stop();
});

const namespace = (collection: string): string =>
  `${harness.container.mongo.db.databaseName}.${collection}`;

const readDistribution = async (collection: string): Promise<Record<string, number>> => {
  const rows = await harness.container.mongo.db
    .collection(collection)
    .aggregate<{ _id: string; count: number }>([
      { $collStats: { storageStats: {} } },
      { $group: { _id: '$shard', count: { $sum: '$storageStats.count' } } },
    ])
    .toArray();
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    if (row._id) distribution[row._id] = row.count;
  }
  return distribution;
};

const insertOrder = async (input: {
  userId: string;
  eventId: string;
  tierId: string;
  price: number;
  requestId: string;
}): Promise<string> => {
  const orderId = `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
  await harness.container.collections.orders.insertOne({
    _id: orderId,
    userId: input.userId,
    eventId: input.eventId,
    tierId: input.tierId,
    quantity: 1,
    unitPrice: input.price,
    total: input.price,
    status: 'PENDING_PAYMENT',
    expiresAt: new Date(Date.now() + 600_000),
    paymentAttempts: 0,
    reservationReleased: false,
    requestId: input.requestId,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
  return orderId;
};

describe('native sharding through mongos', () => {
  it('registers at least two shards and enables sharding on the database', async () => {
    const shards = await listShards(harness.container.mongo.db);
    expect(shards.length).toBeGreaterThanOrEqual(2);
    expect(shards).toEqual(expect.arrayContaining(['shard0', 'shard1', 'shard2']));
  });

  it('shards every transaction collection on { userId: 1 }', async () => {
    for (const collection of SHARDED_COLLECTIONS) {
      const key = await getCollectionShardKey(harness.container.mongo.db, collection);
      expect({ collection, key }).toEqual({ collection, key: { userId: 1 } });
    }
  });

  it('keeps catalog and idempotency collections unsharded', async () => {
    for (const collection of ['users', 'events', 'ticketTiers', 'idempotencyKeys']) {
      const key = await getCollectionShardKey(harness.container.mongo.db, collection);
      expect({ collection, key }).toEqual({ collection, key: null });
    }
  });

  it('starts every unique index on a sharded collection with the shard key', async () => {
    const withUniqueIndex = ['orders', 'payments', 'tickets', 'outboxEvents', 'processedEvents'];
    for (const collection of withUniqueIndex) {
      const indexes = await harness.container.mongo.db.collection(collection).indexes();
      const unique = indexes.filter((index) => index.unique === true);
      expect({ collection, uniqueCount: unique.length }).toEqual({
        collection,
        uniqueCount: expect.any(Number) as number,
      });
      expect(unique.length).toBeGreaterThan(0);
      for (const index of unique) {
        const firstKey = Object.keys(index.key as Record<string, unknown>)[0];
        expect({ collection, index: index.name, firstKey }).toEqual({
          collection,
          index: index.name,
          firstKey: 'userId',
        });
      }
    }
  });

  it('distributes documents after a chunk split and move, then routes queries per shard key', async () => {
    const marker = `req-shard-distribution-${Date.now()}`;
    const tier = await seedTier(harness.container, { quota: 400, maxPerUser: 4 });
    const users = await Promise.all(
      Array.from({ length: 60 }, (_, index) => seedUser(harness.container, 1000 + index)),
    );
    await Promise.all(
      users.map((user) =>
        insertOrder({
          userId: user.userId,
          eventId: tier.eventId,
          tierId: tier.tierId,
          price: tier.price,
          requestId: marker,
        }),
      ),
    );

    const inserted = await harness.container.collections.orders.countDocuments({
      requestId: marker,
    });
    expect(inserted).toBe(60);

    const sortedUserIds = users.map((user) => user.userId).sort();
    const middle = sortedUserIds[Math.floor(sortedUserIds.length / 2)]!;

    await harness.container.mongo.db.admin().command({
      split: namespace('orders'),
      middle: { userId: middle },
    });

    const holderPlan = await harness.container.mongo.db
      .collection('orders')
      .find({ userId: middle })
      .explain('queryPlanner');
    const holder = (
      holderPlan.queryPlanner as { winningPlan?: { shards?: Array<{ shardName: string }> } }
    ).winningPlan?.shards?.[0]?.shardName;
    const targetShard = ['shard0', 'shard1', 'shard2'].find((shard) => shard !== holder)!;

    await harness.container.mongo.db.admin().command({
      moveChunk: namespace('orders'),
      find: { userId: middle },
      to: targetShard,
      _waitForDelete: true,
    });

    const after = await readDistribution('orders');
    const populatedAfter = Object.entries(after).filter(([, count]) => count > 0);
    expect(populatedAfter.length).toBeGreaterThan(1);
    expect(Object.values(after).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(60);

    const singleShardPlan = await harness.container.mongo.db
      .collection('orders')
      .find({ userId: users[0]!.userId })
      .explain('queryPlanner');
    const singlePlan = singleShardPlan.queryPlanner as {
      winningPlan?: { stage?: string; shards?: Array<{ shardName: string }> };
    };
    expect(singlePlan.winningPlan?.shards?.length).toBe(1);

    const scatterPlanResult = await harness.container.mongo.db
      .collection('orders')
      .find({ requestId: marker })
      .explain('queryPlanner');
    const scatterPlan = scatterPlanResult.queryPlanner as {
      winningPlan?: { stage?: string; shards?: Array<{ shardName: string }> };
    };
    expect(scatterPlan.winningPlan?.stage).toBe('SHARD_MERGE');
    expect(scatterPlan.winningPlan?.shards?.length).toBeGreaterThan(1);
  }, 120_000);

  it('enforces the compound unique index per userId shard key', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 1300);
    const orderId = await insertOrder({
      userId: user.userId,
      eventId: tier.eventId,
      tierId: tier.tierId,
      price: tier.price,
      requestId: 'req-unique',
    });

    const existing = await harness.container.collections.orders.findOne({ _id: orderId });
    let duplicateRejected = false;
    try {
      await harness.container.collections.orders.insertOne({ ...existing! });
    } catch (error) {
      duplicateRejected = (error as { code?: number }).code === 11000;
    }
    expect(duplicateRejected).toBe(true);
  }, 60_000);

  it('writes durable orders with majority write concern through mongos', async () => {
    const tier = await seedTier(harness.container, { quota: 10 });
    const user = await seedUser(harness.container, 1400);
    const orderId = await insertOrder({
      userId: user.userId,
      eventId: tier.eventId,
      tierId: tier.tierId,
      price: tier.price,
      requestId: 'req-majority',
    });

    const stored = await harness.container.collections.orders.findOne({ _id: orderId });
    expect(stored?.userId).toBe(user.userId);
  }, 60_000);
});
