import type { Collection, Db } from 'mongodb';
import type {
  ApiKeyDoc,
  AuditLogDoc,
  EventDoc,
  EventStatsDoc,
  IdempotencyKeyDoc,
  OrderDoc,
  OutboxEventDoc,
  PasswordResetTokenDoc,
  PaymentDoc,
  ProcessedEventDoc,
  RefreshTokenDoc,
  RequestTraceDoc,
  TicketDoc,
  TicketTierDoc,
  UserDoc,
  WebhookEndpointDoc,
} from './types.ts';

export const SHARDED_COLLECTIONS = [
  'orders',
  'payments',
  'tickets',
  'outboxEvents',
  'processedEvents',
  'auditLogs',
] as const;

export const UNSHARDED_COLLECTIONS = [
  'users',
  'refreshTokens',
  'passwordResetTokens',
  'apiKeys',
  'events',
  'ticketTiers',
  'webhookEndpoints',
  'idempotencyKeys',
  'eventStats',
] as const;

export const COLLECTIONS = {
  users: 'users',
  refreshTokens: 'refreshTokens',
  passwordResetTokens: 'passwordResetTokens',
  apiKeys: 'apiKeys',
  events: 'events',
  ticketTiers: 'ticketTiers',
  orders: 'orders',
  payments: 'payments',
  tickets: 'tickets',
  outboxEvents: 'outboxEvents',
  processedEvents: 'processedEvents',
  auditLogs: 'auditLogs',
  webhookEndpoints: 'webhookEndpoints',
  idempotencyKeys: 'idempotencyKeys',
  eventStats: 'eventStats',
  requestTraces: 'requestTraces',
} as const;

export interface Collections {
  users: Collection<UserDoc>;
  refreshTokens: Collection<RefreshTokenDoc>;
  passwordResetTokens: Collection<PasswordResetTokenDoc>;
  apiKeys: Collection<ApiKeyDoc>;
  events: Collection<EventDoc>;
  ticketTiers: Collection<TicketTierDoc>;
  orders: Collection<OrderDoc>;
  payments: Collection<PaymentDoc>;
  tickets: Collection<TicketDoc>;
  outboxEvents: Collection<OutboxEventDoc>;
  processedEvents: Collection<ProcessedEventDoc>;
  auditLogs: Collection<AuditLogDoc>;
  webhookEndpoints: Collection<WebhookEndpointDoc>;
  idempotencyKeys: Collection<IdempotencyKeyDoc>;
  eventStats: Collection<EventStatsDoc>;
  requestTraces: Collection<RequestTraceDoc>;
}

export const getCollections = (db: Db): Collections => ({
  users: db.collection<UserDoc>(COLLECTIONS.users),
  refreshTokens: db.collection<RefreshTokenDoc>(COLLECTIONS.refreshTokens),
  passwordResetTokens: db.collection<PasswordResetTokenDoc>(COLLECTIONS.passwordResetTokens),
  apiKeys: db.collection<ApiKeyDoc>(COLLECTIONS.apiKeys),
  events: db.collection<EventDoc>(COLLECTIONS.events),
  ticketTiers: db.collection<TicketTierDoc>(COLLECTIONS.ticketTiers),
  orders: db.collection<OrderDoc>(COLLECTIONS.orders),
  payments: db.collection<PaymentDoc>(COLLECTIONS.payments),
  tickets: db.collection<TicketDoc>(COLLECTIONS.tickets),
  outboxEvents: db.collection<OutboxEventDoc>(COLLECTIONS.outboxEvents),
  processedEvents: db.collection<ProcessedEventDoc>(COLLECTIONS.processedEvents),
  auditLogs: db.collection<AuditLogDoc>(COLLECTIONS.auditLogs),
  webhookEndpoints: db.collection<WebhookEndpointDoc>(COLLECTIONS.webhookEndpoints),
  idempotencyKeys: db.collection<IdempotencyKeyDoc>(COLLECTIONS.idempotencyKeys),
  eventStats: db.collection<EventStatsDoc>(COLLECTIONS.eventStats),
  requestTraces: db.collection<RequestTraceDoc>(COLLECTIONS.requestTraces),
});
