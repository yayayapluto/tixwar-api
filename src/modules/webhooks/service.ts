import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Env } from '../../config/env.ts';
import type { BreakerRegistry } from '../../infra/breaker/registry.ts';
import type { Collections } from '../../infra/db/collections.ts';
import type { WebhookEndpointDoc } from '../../infra/db/types.ts';
import { newWebhookEndpointId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { badRequest, forbidden } from '../../shared/problem.ts';

const logger = createLogger('webhooks');

const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const isPrivateAddress = (address: string): boolean =>
  PRIVATE_RANGES.some((pattern) => pattern.test(address));

export const validateWebhookUrl = async (
  rawUrl: string,
  env: Env,
): Promise<{ url: URL; hostname: string }> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('url must be a valid absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('url must use http or https');
  }
  if (url.protocol === 'http:' && !env.WEBHOOK_ALLOW_HTTP && env.NODE_ENV === 'production') {
    throw badRequest('url must use https in this environment');
  }
  if (url.username || url.password) {
    throw badRequest('url must not contain credentials');
  }

  const hostname = url.hostname.toLowerCase();
  const addresses: string[] = isIP(hostname) ? [hostname] : [];
  if (addresses.length === 0) {
    try {
      const resolved = await lookup(hostname, { all: true });
      addresses.push(...resolved.map((entry) => entry.address));
    } catch {
      throw badRequest('url hostname could not be resolved');
    }
  }

  if (!env.WEBHOOK_ALLOW_PRIVATE_NETWORK) {
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw forbidden('url resolves to a private or metadata address');
      }
    }
  }
  return { url, hostname };
};

const deriveKey = (secret: string): Buffer => scryptSync(secret, 'tixwar-webhook', 32);

export const encryptSecret = (plaintext: string, keyMaterial: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`;
};

export const decryptSecret = (payload: string, keyMaterial: string): string => {
  const [ivPart, dataPart, tagPart] = payload.split('.');
  if (!ivPart || !dataPart || !tagPart) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(keyMaterial),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

export const signWebhook = (input: { secret: string; timestamp: number; body: string }): string => {
  const signature = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest('hex');
  return `t=${input.timestamp},v1=${signature}`;
};

export interface WebhookDeps {
  env: Env;
  collections: Collections;
  breakers: BreakerRegistry;
}

export class WebhookService {
  private readonly deps: WebhookDeps;

  constructor(deps: WebhookDeps) {
    this.deps = deps;
  }

  async register(input: { ownerId: string; url: string }): Promise<{
    endpoint: WebhookEndpointDoc;
    secret: string;
  }> {
    const { url } = await validateWebhookUrl(input.url, this.deps.env);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const now = new Date();
    const endpoint: WebhookEndpointDoc = {
      _id: newWebhookEndpointId(),
      ownerId: input.ownerId,
      url: url.toString(),
      secretEncrypted: encryptSecret(secret, this.deps.env.JWT_REFRESH_SECRET),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.collections.webhookEndpoints.insertOne(endpoint);
    return { endpoint, secret };
  }

  async list(ownerId: string): Promise<Array<Omit<WebhookEndpointDoc, 'secretEncrypted'>>> {
    const docs = await this.deps.collections.webhookEndpoints
      .find({ ownerId })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map((doc) => ({
      _id: doc._id,
      ownerId: doc.ownerId,
      url: doc.url,
      active: doc.active,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
  }

  async deactivate(ownerId: string, endpointId: string): Promise<void> {
    await this.deps.collections.webhookEndpoints.updateOne(
      { _id: endpointId, ownerId },
      { $set: { active: false, updatedAt: new Date() } },
    );
  }

  async deliverForUser(input: {
    userId: string;
    eventType: string;
    payload: Record<string, unknown>;
    requestId: string;
  }): Promise<void> {
    const endpoints = await this.deps.collections.webhookEndpoints
      .find({ ownerId: input.userId, active: true })
      .toArray();
    for (const endpoint of endpoints) {
      await this.deliver({
        endpoint,
        eventType: input.eventType,
        payload: input.payload,
        requestId: input.requestId,
      });
    }
  }

  private async deliver(input: {
    endpoint: WebhookEndpointDoc;
    eventType: string;
    payload: Record<string, unknown>;
    requestId: string;
  }): Promise<void> {
    const secret = decryptSecret(input.endpoint.secretEncrypted, this.deps.env.JWT_REFRESH_SECRET);
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: `whd_${randomUUID()}`,
      type: input.eventType,
      occurredAt: new Date().toISOString(),
      requestId: input.requestId,
      data: input.payload,
    });
    const signature = signWebhook({ secret, timestamp, body });
    const host = new URL(input.endpoint.url).hostname;

    const breaker = this.deps.breakers.get(
      'webhook',
      async (payload: { url: string; body: string; signature: string }) => {
        const response = await fetch(payload.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tixwar-signature': payload.signature,
            'user-agent': 'TixWar-Webhook/1.0',
          },
          body: payload.body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.deps.env.WEBHOOK_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`webhook target responded ${response.status}`);
        }
      },
      { timeout: this.deps.env.WEBHOOK_TIMEOUT_MS },
    );

    try {
      await breaker.fire({ url: input.endpoint.url, body, signature });
      logger.info({ endpointId: input.endpoint._id, host }, 'webhook delivered');
    } catch (error) {
      logger.warn(
        { err: error, endpointId: input.endpoint._id, host, requestId: input.requestId },
        'webhook delivery failed',
      );
      throw error;
    }
  }
}
