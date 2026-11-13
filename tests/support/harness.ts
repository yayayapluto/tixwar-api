import type { Server } from 'node:http';
import { runMigrations } from '../../scripts/migrate-lib.ts';
import { createApp } from '../../src/app.ts';
import { type Container, createContainer } from '../../src/bootstrap.ts';
import { getEnv } from '../../src/config/env.ts';
import type { EventDoc, TicketTierDoc } from '../../src/infra/db/types.ts';
import { createUser } from '../../src/modules/auth/service.ts';
import { newEventId, newTierId } from '../../src/shared/ids.ts';

export interface Harness {
  container: Container;
  server: Server;
  baseUrl: string;
  stop: () => Promise<void>;
}

let shared: Harness | null = null;

const COLLECTIONS_TO_CLEAR = [
  'users',
  'refreshTokens',
  'apiKeys',
  'events',
  'ticketTiers',
  'orders',
  'payments',
  'tickets',
  'outboxEvents',
  'processedEvents',
  'auditLogs',
  'webhookEndpoints',
  'idempotencyKeys',
  'eventStats',
];

export const resetDatabase = async (container: Container): Promise<void> => {
  for (const name of COLLECTIONS_TO_CLEAR) {
    await container.mongo.db.collection(name).deleteMany({});
  }
  const keys = await container.redis.keys('stock:*');
  if (keys.length > 0) await container.redis.del(...keys);
  const reserved = await container.redis.keys('reserved:*');
  if (reserved.length > 0) await container.redis.del(...reserved);
  const locks = await container.redis.keys('lock:*');
  if (locks.length > 0) await container.redis.del(...locks);
};

export const getHarness = async (): Promise<Harness> => {
  if (shared) return shared;
  const env = getEnv();
  const container = await createContainer(env);
  await runMigrations(container.mongo.db, env);
  await resetDatabase(container);

  const app = createApp(container);
  const server = app.listen(0);
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : env.PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  container.selfBaseUrl = baseUrl;

  shared = {
    container,
    server,
    baseUrl,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await container.shutdown();
      shared = null;
    },
  };
  return shared;
};

export interface SeededTier {
  eventId: string;
  tierId: string;
  quota: number;
  maxPerUser: number;
  price: number;
}

export const seedTier = async (
  container: Container,
  input: { quota: number; maxPerUser?: number; price?: number; saleWindowMs?: number },
): Promise<SeededTier> => {
  const now = new Date();
  const eventId = newEventId();
  const tierId = newTierId();
  const event: EventDoc = {
    _id: eventId,
    name: `Integration Event ${eventId}`,
    description: 'integration test event',
    category: 'music',
    city: 'jakarta',
    venue: 'Test Hall',
    startsAt: new Date(now.getTime() + 86_400_000),
    status: 'ON_SALE',
    searchText: 'integration test event',
    createdBy: 'usr_system',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const tier: TicketTierDoc = {
    _id: tierId,
    eventId,
    name: 'Bronze',
    price: input.price ?? 100_000,
    quota: input.quota,
    saleStartsAt: new Date(now.getTime() - 60_000),
    saleEndsAt: new Date(now.getTime() + (input.saleWindowMs ?? 86_400_000)),
    maxPerUser: input.maxPerUser ?? 4,
    createdAt: now,
    updatedAt: now,
  };
  await container.collections.events.insertOne(event);
  await container.collections.ticketTiers.insertOne(tier);
  await container.stock.prewarm(tierId, input.quota);
  return {
    eventId,
    tierId,
    quota: input.quota,
    maxPerUser: tier.maxPerUser,
    price: tier.price,
  };
};

export const seedUser = async (
  container: Container,
  index: number,
): Promise<{ userId: string; email: string; accessToken: string }> => {
  const email = `integration-${index}-${Date.now()}@tixwar.local`;
  const created = await createUser({
    collections: container.collections,
    email,
    password: 'Integration-Password-2024',
  });
  const accessToken = await container.tokens.signAccessToken({
    userId: created.id,
    role: created.role,
  });
  return { userId: created.id, email, accessToken };
};

export const jsonRequest = async (
  baseUrl: string,
  method: string,
  path: string,
  input: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.headers ?? {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
};

export const waitFor = async <T>(
  check: () => Promise<T | null | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
};

export interface TestWorkers {
  close: () => Promise<void>;
}

export const startTestWorkers = async (
  container: Container,
  options: { concurrency?: number } = {},
): Promise<TestWorkers> => {
  const { Worker } = await import('bullmq');
  const { buildHandlers } = await import('../../src/events/handlers.ts');
  const { QUEUE_NAMES, workerOptions } = await import('../../src/infra/queue/queues.ts');

  const handlers = buildHandlers({
    env: container.env,
    collections: container.collections,
    client: container.client,
    orders: container.orders,
    payments: container.payments,
    tickets: container.tickets,
    notifications: container.notifications,
    webhooks: container.webhooks,
    gateway: container.gateway,
    breakers: container.breakers,
    pubsub: container.pubsub,
  });

  const workers: Array<{ close: () => Promise<void> }> = [];
  for (const name of Object.values(QUEUE_NAMES)) {
    if (name === QUEUE_NAMES.dlq || name === QUEUE_NAMES.expiry) continue;
    const worker = new Worker(
      `${container.env.QUEUE_PREFIX}-${name}`,
      async (job) => {
        const handler = handlers[job.data.type];
        if (!handler) return;
        await handler(job.data);
      },
      {
        ...workerOptions(container.env, name, container.redis),
        concurrency: options.concurrency ?? 20,
      },
    );
    workers.push(worker);
  }

  return {
    close: async () => {
      await Promise.allSettled(workers.map((worker) => worker.close()));
    },
  };
};

export interface TestPublisher {
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  published: () => number;
}

export const startTestPublisher = async (container: Container): Promise<TestPublisher> => {
  const { publishBatch } = await import('../../src/events/publisher.ts');
  let stopped = false;
  let paused = false;
  let published = 0;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (!paused) {
        try {
          const result = await publishBatch({
            env: container.env,
            collections: container.collections,
            queues: container.queues,
          });
          published += result.published;
        } catch {
          // keep the loop alive; failures surface through assertions
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
    }
  };

  void loop();

  return {
    stop: async () => {
      stopped = true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    published: () => published,
  };
};
