import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';

export const ID_PREFIXES = {
  user: 'usr_',
  event: 'evt_',
  tier: 'tier_',
  order: 'ord_',
  payment: 'pay_',
  ticket: 'tix_',
  webhookEndpoint: 'whk_',
  outboxEvent: 'obx_',
} as const;

const withPrefix = (prefix: string, value: string): string => `${prefix}${value}`;

export const newUserId = (): string => withPrefix(ID_PREFIXES.user, randomUUID());

export const newUlidId = (kind: keyof typeof ID_PREFIXES): string =>
  withPrefix(ID_PREFIXES[kind], ulid());

export const newEventId = (): string => newUlidId('event');
export const newTierId = (): string => newUlidId('tier');
export const newOrderId = (): string => newUlidId('order');
export const newPaymentId = (): string => newUlidId('payment');
export const newTicketId = (): string => newUlidId('ticket');
export const newWebhookEndpointId = (): string => newUlidId('webhookEndpoint');
export const newOutboxEventId = (): string => newUlidId('outboxEvent');

export const hasPrefix = (value: string, kind: keyof typeof ID_PREFIXES): boolean =>
  value.startsWith(ID_PREFIXES[kind]);

export const isUserId = (value: string): boolean => hasPrefix(value, 'user');
