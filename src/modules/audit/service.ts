import { randomUUID } from 'node:crypto';
import type { Collections } from '../../infra/db/collections.ts';

export interface AuditInput {
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  diff?: Record<string, unknown> | null;
  requestId: string;
}

export const SYSTEM_ACTOR = 'usr_system';

export const audit = async (collections: Collections, input: AuditInput): Promise<void> => {
  await collections.auditLogs.insertOne({
    _id: `aud_${randomUUID()}`,
    userId: input.userId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    diff: input.diff ?? null,
    requestId: input.requestId,
    createdAt: new Date(),
  });
};
