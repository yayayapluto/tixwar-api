import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';

export interface GatewayState {
  failMode: boolean;
  latencyMs: number;
  chargeCount: number;
}

export interface MockGateway {
  app: Express;
  state: GatewayState;
  listen: (port?: number) => Promise<{ server: Server; port: number; baseUrl: string }>;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const createMockGateway = (): MockGateway => {
  const state: GatewayState = { failMode: false, latencyMs: 0, chargeCount: 0 };
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.post('/charge', async (req, res) => {
    const body = req.body as {
      orderId?: string;
      paymentId?: string;
      amount?: number;
      attempt?: number;
    };
    if (!body.orderId || !body.paymentId || typeof body.amount !== 'number') {
      res.status(400).json({ error: 'orderId, paymentId and amount are required' });
      return;
    }

    if (state.latencyMs > 0) await sleep(state.latencyMs);

    if (state.failMode) {
      res.status(503).json({ error: 'gateway unavailable (chaos toggle active)' });
      return;
    }

    state.chargeCount += 1;
    res.json({
      providerRef: `pg_${randomUUID()}`,
      status: 'SUCCEEDED',
      attempt: body.attempt ?? 1,
    });
  });

  app.post('/toggle-fail', (req, res) => {
    const enabled = req.body?.enabled;
    state.failMode = typeof enabled === 'boolean' ? enabled : !state.failMode;
    res.json({ failMode: state.failMode });
  });

  app.post('/latency', (req, res) => {
    const value = Number(req.body?.latencyMs ?? 0);
    state.latencyMs = Number.isFinite(value) && value >= 0 ? value : 0;
    res.json({ latencyMs: state.latencyMs });
  });

  app.get('/state', (_req, res) => {
    res.json({ ...state });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: state.failMode ? 'degraded' : 'ok' });
  });

  return {
    app,
    state,
    listen: async (port = 0) => {
      const server = app.listen(port);
      await new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once('listening', () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { server, port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}` };
    },
  };
};
