import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { metrics } from '../infra/metrics/registry.ts';
import { createLogger } from '../shared/logger.ts';

const logger = createLogger('sse');

export interface SseSession {
  close: () => Promise<void>;
  channel: string;
}

const HEARTBEAT_MS = 15000;

export const openSseStream = async (input: {
  req: Request;
  res: Response;
  subscriber: Redis;
  channel: string;
  label: string;
  lastEventId?: string;
}): Promise<SseSession> => {
  const { req, res, subscriber, channel, label } = input;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  metrics.sseConnections.inc({ channel: label });

  let closed = false;
  let sequence = 0;

  const write = (event: string, payload: unknown, id?: string): void => {
    if (closed) return;
    sequence += 1;
    const lines = [
      `event: ${event}`,
      `id: ${id ?? `${Date.now()}-${sequence}`}`,
      `data: ${JSON.stringify(payload)}`,
      '',
      '',
    ];
    res.write(lines.join('\n'));
  };

  write(
    'ready',
    { channel: label, connectedAt: new Date().toISOString() },
    input.lastEventId ?? '0',
  );

  const onMessage = (incomingChannel: string, message: string): void => {
    if (incomingChannel !== channel) return;
    try {
      write('message', JSON.parse(message));
    } catch {
      write('message', { raw: message });
    }
  };

  await subscriber.subscribe(channel);
  subscriber.on('message', onMessage);

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, HEARTBEAT_MS);

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscriber.off('message', onMessage);
    try {
      await subscriber.unsubscribe(channel);
    } catch (error) {
      logger.debug({ err: error, channel }, 'unsubscribe failed');
    }
    metrics.sseConnections.dec({ channel: label });
    if (!res.writableEnded) res.end();
  };

  req.on('close', () => {
    void cleanup();
  });
  res.on('error', () => {
    void cleanup();
  });

  return { close: cleanup, channel };
};
