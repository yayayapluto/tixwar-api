import { describe, expect, it } from 'bun:test';
import { decodeCursor, encodeCursor } from '../../src/shared/cursor.ts';
import { AppError } from '../../src/shared/problem.ts';

describe('cursor codec', () => {
  it('round-trips sort tuple, id and scope', () => {
    const encoded = encodeCursor({
      sort: { startsAt: '2026-01-01T00:00:00.000Z' },
      id: 'evt_01ABC',
      scope: 'usr_01XYZ',
    });
    const decoded = decodeCursor(encoded);
    expect(decoded.v).toBe(1);
    expect(decoded.id).toBe('evt_01ABC');
    expect(decoded.scope).toBe('usr_01XYZ');
    expect((decoded.sort as Record<string, unknown>).startsAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('produces url-safe opaque output without raw payload', () => {
    const encoded = encodeCursor({ sort: { name: 'a' }, id: 'evt_1' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('evt_1');
  });

  it('rejects malformed base64 payloads', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow(AppError);
  });

  it('rejects unsupported cursor versions', () => {
    const payload = Buffer.from(JSON.stringify({ v: 99, id: 'evt_1', sort: {} })).toString(
      'base64url',
    );
    expect(() => decodeCursor(payload)).toThrow(/unsupported cursor version/);
  });

  it('rejects payloads without tie-breaker id', () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, sort: {} })).toString('base64url');
    expect(() => decodeCursor(payload)).toThrow(/tie-breaker/);
  });
});
