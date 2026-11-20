import type { Document } from 'mongodb';

export type UserRole = 'user' | 'admin';

export interface UserDoc extends Document {
  _id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RefreshTokenDoc extends Document {
  _id: string;
  userId: string;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  userAgent?: string;
}

export interface ApiKeyDoc extends Document {
  _id: string;
  ownerId: string;
  name: string;
  keyHash: string;
  prefix: string;
  active: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PasswordResetTokenDoc extends Document {
  _id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
}

export type EventStatus = 'DRAFT' | 'SCHEDULED' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED';

export interface EventDoc extends Document {
  _id: string;
  name: string;
  description: string;
  category: string;
  city: string;
  venue: string;
  startsAt: Date;
  status: EventStatus;
  searchText: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TicketTierDoc extends Document {
  _id: string;
  eventId: string;
  name: string;
  price: number;
  quota: number;
  saleStartsAt: Date;
  saleEndsAt: Date;
  maxPerUser: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_QUEUED'
  | 'PAID'
  | 'CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface OrderDoc extends Document {
  _id: string;
  userId: string;
  eventId: string;
  tierId: string;
  quantity: number;
  unitPrice: number;
  total: number;
  status: OrderStatus;
  expiresAt: Date;
  paymentAttempts: number;
  reservationReleased: boolean;
  requestId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type PaymentStatus = 'QUEUED' | 'SUCCEEDED' | 'FAILED';

export interface PaymentDoc extends Document {
  _id: string;
  orderId: string;
  userId: string;
  status: PaymentStatus;
  attempt: number;
  providerRef: string | null;
  idempotencyKey: string;
  amount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketDoc extends Document {
  _id: string;
  orderId: string;
  userId: string;
  eventId: string;
  tierId: string;
  code: string;
  qrObjectKey: string;
  issuedAt: Date;
}

export type OutboxStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

export interface OutboxEventDoc extends Document {
  _id: string;
  userId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  leaseUntil: Date | null;
  lastError: string | null;
  requestId: string;
}

export interface ProcessedEventDoc extends Document {
  _id: string;
  userId: string;
  eventId: string;
  consumer: string;
  processedAt: Date;
}

export interface AuditLogDoc extends Document {
  _id: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  requestId: string;
  createdAt: Date;
}

export interface WebhookEndpointDoc extends Document {
  _id: string;
  ownerId: string;
  url: string;
  secretEncrypted: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdempotencyKeyDoc extends Document {
  _id: string;
  scope: string;
  ownerId: string;
  key: string;
  requestHash: string;
  response: { status: number; body: unknown } | null;
  status: 'IN_PROGRESS' | 'COMPLETED';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestTraceDoc extends Document {
  ts: Date;
  meta: { node: string; service: string; requestId: string };
  step: string;
  status: string;
  durationMs: number;
  payload: Record<string, unknown>;
}

export interface EventStatsDoc extends Document {
  _id: string;
  eventId: string;
  sold: number;
  revenue: number;
  updatedAt: Date;
}
