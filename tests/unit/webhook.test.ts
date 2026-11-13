import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { getEnv } from '../../src/config/env.ts';
import {
  decryptSecret,
  encryptSecret,
  signWebhook,
  validateWebhookUrl,
} from '../../src/modules/webhooks/service.ts';

const env = getEnv();

describe('webhook signing', () => {
  it('produces a verifiable HMAC SHA-256 signature over timestamp and body', () => {
    const secret = 'whsec_test_secret';
    const timestamp = 1_700_000_000;
    const body = JSON.stringify({ hello: 'world' });
    const header = signWebhook({ secret, timestamp, body });
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    expect(header).toBe(`t=${timestamp},v1=${expected}`);
  });

  it('changes signature when the body changes', () => {
    const base = { secret: 's', timestamp: 1 };
    expect(signWebhook({ ...base, body: 'a' })).not.toBe(signWebhook({ ...base, body: 'b' }));
  });

  it('encrypts and decrypts endpoint secrets with AES-256-GCM', () => {
    const secret = 'whsec_super_secret_value';
    const encrypted = encryptSecret(secret, 'key-material-0123456789');
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, 'key-material-0123456789')).toBe(secret);
  });

  it('fails decryption when the key material differs', () => {
    const encrypted = encryptSecret('secret', 'key-a-0123456789');
    expect(() => decryptSecret(encrypted, 'key-b-0123456789')).toThrow();
  });
});

describe('webhook URL validation', () => {
  it('accepts http URLs when the environment allows them', async () => {
    const result = await validateWebhookUrl('http://example.com/hook', env);
    expect(result.url.hostname).toBe('example.com');
  });

  it('rejects non-http protocols', async () => {
    await expect(validateWebhookUrl('file:///etc/passwd', env)).rejects.toThrow(/http or https/);
    await expect(validateWebhookUrl('ftp://example.com/hook', env)).rejects.toThrow(
      /http or https/,
    );
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(validateWebhookUrl('http://user:pass@example.com/hook', env)).rejects.toThrow(
      /credentials/,
    );
  });

  it('rejects malformed URLs', async () => {
    await expect(validateWebhookUrl('not-a-url', env)).rejects.toThrow(/valid absolute URL/);
  });

  it('blocks private and metadata addresses when private network is disallowed', async () => {
    const strictEnv = { ...env, WEBHOOK_ALLOW_PRIVATE_NETWORK: false };
    await expect(validateWebhookUrl('http://127.0.0.1/hook', strictEnv)).rejects.toThrow(
      /private or metadata/,
    );
    await expect(
      validateWebhookUrl('http://169.254.169.254/latest/meta-data', strictEnv),
    ).rejects.toThrow(/private or metadata/);
    await expect(validateWebhookUrl('http://10.0.0.5/hook', strictEnv)).rejects.toThrow(
      /private or metadata/,
    );
  });
});
