import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.ts';
import type { BreakerRegistry } from '../../infra/breaker/registry.ts';
import type { Collections } from '../../infra/db/collections.ts';
import { createLogger } from '../../shared/logger.ts';

const logger = createLogger('notifications');

export interface NotificationDeps {
  env: Env;
  collections: Collections;
  breakers: BreakerRegistry;
}

export class NotificationService {
  private readonly deps: NotificationDeps;
  private transporter: Transporter | null = null;

  constructor(deps: NotificationDeps) {
    this.deps = deps;
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      const url = new URL(this.deps.env.SMTP_URL);
      this.transporter = nodemailer.createTransport({
        host: url.hostname,
        port: url.port ? Number(url.port) : 1025,
        secure: url.protocol === 'smtps:',
        auth:
          url.username && url.password
            ? {
                user: decodeURIComponent(url.username),
                pass: decodeURIComponent(url.password),
              }
            : undefined,
        connectionTimeout: this.deps.env.SMTP_TIMEOUT_MS,
        greetingTimeout: this.deps.env.SMTP_TIMEOUT_MS,
        socketTimeout: this.deps.env.SMTP_TIMEOUT_MS,
      });
    }
    return this.transporter;
  }

  private async send(input: {
    userId: string;
    subject: string;
    body: string;
    requestId: string;
  }): Promise<void> {
    const user = await this.deps.collections.users.findOne({ _id: input.userId });
    if (!user) {
      logger.warn({ userId: input.userId }, 'notification skipped: user not found');
      return;
    }
    const breaker = this.deps.breakers.get(
      'smtp',
      async (payload: { to: string; subject: string; text: string }) => {
        await this.getTransporter().sendMail({
          from: this.deps.env.MAIL_FROM,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
        });
      },
      { timeout: this.deps.env.SMTP_TIMEOUT_MS },
    );
    try {
      await breaker.fire({ to: user.email, subject: input.subject, text: input.body });
      logger.info({ userId: input.userId, requestId: input.requestId }, 'email sent');
    } catch (error) {
      logger.warn(
        { err: error, userId: input.userId, requestId: input.requestId },
        'email delivery failed',
      );
      throw error;
    }
  }

  async sendOrderCreated(input: {
    userId: string;
    orderId: string;
    requestId: string;
  }): Promise<void> {
    await this.send({
      userId: input.userId,
      subject: `TixWar order ${input.orderId} created`,
      body: `Your order ${input.orderId} is waiting for payment. Complete payment before it expires.`,
      requestId: input.requestId,
    });
  }

  async sendTicketIssued(input: {
    userId: string;
    orderId: string;
    ticketCode: string;
    requestId: string;
  }): Promise<void> {
    await this.send({
      userId: input.userId,
      subject: `TixWar ticket issued for order ${input.orderId}`,
      body: `Your payment was confirmed. Ticket code: ${input.ticketCode}`,
      requestId: input.requestId,
    });
  }

  async sendPaymentFailed(input: {
    userId: string;
    orderId: string;
    requestId: string;
  }): Promise<void> {
    await this.send({
      userId: input.userId,
      subject: `TixWar payment failed for order ${input.orderId}`,
      body: `Payment attempts for order ${input.orderId} were exhausted. Stock has been released.`,
      requestId: input.requestId,
    });
  }

  async sendRaw(input: {
    userId: string;
    subject: string;
    body: string;
    requestId: string;
  }): Promise<void> {
    await this.send(input);
  }
}
