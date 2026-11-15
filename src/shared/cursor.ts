import { badRequest } from './problem.ts';

export interface CursorPayload {
  v: 1;
  sort: unknown;
  id: string;
  scope?: string;
}

const CURSOR_VERSION = 1;

export const encodeCursor = (payload: Omit<CursorPayload, 'v'>): string => {
  const body: CursorPayload = { v: CURSOR_VERSION, ...payload };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
};

export const decodeCursor = (raw: string): CursorPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('cursor is not a valid opaque cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw badRequest('cursor payload is malformed');
  }
  const candidate = parsed as Partial<CursorPayload>;
  if (candidate.v !== CURSOR_VERSION) {
    throw badRequest(`unsupported cursor version: ${String(candidate.v)}`);
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw badRequest('cursor is missing the tie-breaker id');
  }
  if (candidate.scope !== undefined && typeof candidate.scope !== 'string') {
    throw badRequest('cursor scope must be a string');
  }
  return candidate as CursorPayload;
};
