import { faker } from '@faker-js/faker';
import { getEnv } from '../src/config/env.ts';
import { connectMongo } from '../src/infra/db/client.ts';
import { getCollections } from '../src/infra/db/collections.ts';
import type { EventDoc, TicketTierDoc } from '../src/infra/db/types.ts';
import { connectRedis } from '../src/infra/redis/client.ts';
import { StockGate } from '../src/infra/redis/stock.ts';
import { createUser } from '../src/modules/auth/service.ts';
import { newEventId, newTierId } from '../src/shared/ids.ts';
import { runMigrations } from './migrate-lib.ts';

const EVENT_COUNT = 20;
const TIERS_PER_EVENT = 3;
const USER_COUNT = 5000;
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'TixWar-Seed-2024';

const CATEGORIES = ['music', 'conference', 'sports', 'theater', 'workshop'];
const CITIES = ['jakarta', 'bandung', 'surabaya', 'yogyakarta', 'medan'];

const main = async (): Promise<void> => {
  const env = getEnv();
  const mongo = await connectMongo(env);
  const redisCtx = await connectRedis(env);
  const collections = getCollections(mongo.db);
  const stock = new StockGate(redisCtx.client);

  try {
    await runMigrations(mongo.db, env);

    const existingEvents = await collections.events.countDocuments({});
    if (existingEvents > 0 && !process.argv.includes('--force')) {
      console.log(
        JSON.stringify({
          status: 'skipped',
          reason: 'events already exist; pass --force to reseed',
        }),
      );
      return;
    }

    if (process.argv.includes('--force')) {
      for (const name of [
        'orders',
        'payments',
        'tickets',
        'outboxEvents',
        'processedEvents',
        'auditLogs',
        'events',
        'ticketTiers',
        'eventStats',
      ]) {
        await mongo.db.collection(name).deleteMany({});
      }
    }

    faker.seed(20240101);
    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@tixwar.local';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'TixWar-Admin-2024';
    const admin = await createUser({
      collections,
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
    }).catch(async () => {
      const existing = await collections.users.findOne({ email: adminEmail });
      if (!existing) throw new Error('failed to create seed admin');
      return { id: existing._id, email: existing.email, role: existing.role };
    });

    const now = Date.now();
    const eventDocs: EventDoc[] = [];
    const tierDocs: TicketTierDoc[] = [];

    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const name = `${faker.music.genre()} ${faker.word.adjective()} Night ${index + 1}`;
      const description = faker.lorem.paragraph();
      const startsAt = new Date(now + (index + 1) * 24 * 3600 * 1000);
      const eventId = newEventId();
      eventDocs.push({
        _id: eventId,
        name,
        description,
        category: CATEGORIES[index % CATEGORIES.length]!,
        city: CITIES[index % CITIES.length]!,
        venue: `${faker.location.street()} Hall`,
        startsAt,
        status: 'ON_SALE',
        searchText: `${name} ${description}`.toLowerCase(),
        createdBy: admin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      for (let tierIndex = 0; tierIndex < TIERS_PER_EVENT; tierIndex += 1) {
        const quota = [50, 100, 200][tierIndex] ?? 50;
        tierDocs.push({
          _id: newTierId(),
          eventId,
          name: ['Bronze', 'Silver', 'Gold'][tierIndex] ?? 'Bronze',
          price: (tierIndex + 1) * 150_000,
          quota,
          saleStartsAt: new Date(now - 3600_000),
          saleEndsAt: new Date(startsAt.getTime() - 3600_000),
          maxPerUser: 4,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    await collections.events.insertMany(eventDocs, { writeConcern: { w: 'majority' } });
    await collections.ticketTiers.insertMany(tierDocs, { writeConcern: { w: 'majority' } });

    const existingUsers = await collections.users.countDocuments({});
    if (existingUsers < USER_COUNT) {
      const batchSize = 250;
      for (let offset = 0; offset < USER_COUNT - existingUsers; offset += batchSize) {
        const batch = Array.from(
          { length: Math.min(batchSize, USER_COUNT - existingUsers - offset) },
          (_, index) => ({
            email: `load-${existingUsers + offset + index}@tixwar.local`,
            password: SEED_PASSWORD,
          }),
        );
        await Promise.all(
          batch.map((entry) =>
            createUser({ collections, email: entry.email, password: entry.password }).catch(
              () => null,
            ),
          ),
        );
      }
    }

    for (const tier of tierDocs) {
      await stock.prewarm(tier._id, tier.quota);
    }

    console.log(
      JSON.stringify(
        {
          status: 'seeded',
          events: eventDocs.length,
          tiers: tierDocs.length,
          users: await collections.users.countDocuments({}),
          adminEmail,
          adminPassword,
          loadUserPassword: SEED_PASSWORD,
          prewarmedTiers: tierDocs.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await redisCtx.close();
    await mongo.close();
  }
};

await main();
