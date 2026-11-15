import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
};

export const hashRequest = (value: unknown): string => sha256Hex(stableStringify(value));

export const hmacSha256Hex = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

export const safeEqualHex = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};
