import type { Db } from 'mongodb';
import type { MigrationStep } from './types.ts';

const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_QUEUED',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
];

const VALIDATORS: Record<string, Record<string, unknown>> = {
  users: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'email', 'passwordHash', 'role', 'createdAt', 'updatedAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^usr_' },
        email: { bsonType: 'string', minLength: 3 },
        passwordHash: { bsonType: 'string', minLength: 1 },
        role: { enum: ['user', 'admin'] },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        deletedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  events: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name', 'startsAt', 'status', 'createdAt', 'updatedAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^evt_' },
        name: { bsonType: 'string', minLength: 1, maxLength: 200 },
        description: { bsonType: 'string', maxLength: 5000 },
        status: { enum: ['DRAFT', 'SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'ENDED'] },
        startsAt: { bsonType: 'date' },
        deletedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  ticketTiers: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'eventId',
        'name',
        'price',
        'quota',
        'saleStartsAt',
        'saleEndsAt',
        'maxPerUser',
      ],
      properties: {
        _id: { bsonType: 'string', pattern: '^tier_' },
        eventId: { bsonType: 'string', pattern: '^evt_' },
        price: { bsonType: 'int', minimum: 0 },
        quota: { bsonType: 'int', minimum: 0 },
        maxPerUser: { bsonType: 'int', minimum: 1, maximum: 100 },
        saleStartsAt: { bsonType: 'date' },
        saleEndsAt: { bsonType: 'date' },
      },
    },
  },
  orders: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'userId', 'eventId', 'tierId', 'quantity', 'status', 'expiresAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^ord_' },
        userId: { bsonType: 'string', pattern: '^usr_' },
        eventId: { bsonType: 'string', pattern: '^evt_' },
        tierId: { bsonType: 'string', pattern: '^tier_' },
        quantity: { bsonType: 'int', minimum: 1, maximum: 100 },
        unitPrice: { bsonType: 'int', minimum: 0 },
        total: { bsonType: 'int', minimum: 0 },
        status: { enum: ORDER_STATUSES },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  payments: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'userId', 'orderId', 'status', 'attempt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^pay_' },
        userId: { bsonType: 'string', pattern: '^usr_' },
        orderId: { bsonType: 'string', pattern: '^ord_' },
        status: { enum: ['QUEUED', 'SUCCEEDED', 'FAILED'] },
        attempt: { bsonType: 'int', minimum: 1 },
      },
    },
  },
  tickets: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'userId', 'orderId', 'code', 'issuedAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^tix_' },
        userId: { bsonType: 'string', pattern: '^usr_' },
        orderId: { bsonType: 'string', pattern: '^ord_' },
        code: { bsonType: 'string', minLength: 8 },
        issuedAt: { bsonType: 'date' },
      },
    },
  },
  outboxEvents: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'userId', 'type', 'status', 'attempts', 'createdAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^obx_' },
        userId: { bsonType: 'string', pattern: '^usr_' },
        type: { bsonType: 'string', minLength: 3 },
        status: { enum: ['PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'] },
        attempts: { bsonType: 'int', minimum: 0 },
      },
    },
  },
  idempotencyKeys: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'scope', 'ownerId', 'key', 'requestHash', 'status', 'expiresAt'],
      properties: {
        scope: { bsonType: 'string', minLength: 1 },
        ownerId: { bsonType: 'string', minLength: 1 },
        key: { bsonType: 'string', minLength: 1 },
        requestHash: { bsonType: 'string', minLength: 16 },
        status: { enum: ['IN_PROGRESS', 'COMPLETED'] },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
};

export const createJsonSchemaValidationMigration: MigrationStep = {
  id: '003-json-schema-validation',
  description: 'Apply database-level JSON Schema validators to transaction collections',
  up: async (db: Db) => {
    for (const [collection, validator] of Object.entries(VALIDATORS)) {
      try {
        await db.command({
          collMod: collection,
          validator,
          validationLevel: 'moderate',
          validationAction: 'error',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ns does not exist')) continue;
        throw error;
      }
    }
  },
};
