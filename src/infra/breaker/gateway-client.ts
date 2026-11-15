import type { Env } from '../../config/env.ts';
import { createLogger } from '../../shared/logger.ts';
import type { BreakerRegistry } from '../breaker/registry.ts';

const logger = createLogger('gateway');

export interface GatewayChargeResult {
  providerRef: string;
  status: 'SUCCEEDED' | 'FAILED';
  reason?: string;
}

export class PaymentGatewayClient {
  private readonly env: Env;
  private readonly breakers: BreakerRegistry;

  constructor(env: Env, breakers: BreakerRegistry) {
    this.env = env;
    this.breakers = breakers;
  }

  async charge(input: {
    orderId: string;
    paymentId: string;
    amount: number;
    attempt: number;
    idempotencyKey: string;
  }): Promise<GatewayChargeResult> {
    const breaker = this.breakers.get('payment-gateway', async (payload: typeof input) => {
      const response = await fetch(`${this.env.GATEWAY_URL}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': payload.idempotencyKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.env.GATEWAY_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`gateway responded ${response.status}: ${text.slice(0, 200)}`);
      }
      return (await response.json()) as GatewayChargeResult;
    });

    try {
      return await breaker.fire(input);
    } catch (error) {
      logger.warn({ err: error, orderId: input.orderId }, 'gateway charge failed');
      throw error;
    }
  }
}
