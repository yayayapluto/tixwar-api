import type { Redis } from 'ioredis';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('pubsub');

export const CHANNEL = {
  stock: (eventId: string) => `stock:${eventId}`,
  order: (orderId: string) => `order:${orderId}`,
  trace: (name: string) => name,
} as const;

export class PubSub {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(publisher: Redis, subscriber: Redis) {
    this.publisher = publisher;
    this.subscriber = subscriber;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.publisher.publish(channel, JSON.stringify(payload));
    } catch (error) {
      logger.warn({ err: error, channel }, 'publish failed');
    }
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (incomingChannel, message) => {
      if (incomingChannel === channel) handler(message);
    });
  }

  async subscribePattern(
    pattern: string,
    handler: (channel: string, message: string) => void,
  ): Promise<void> {
    await this.subscriber.psubscribe(pattern);
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      handler(channel, message);
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
  }
}
