import type { Request } from 'express';
import { badRequest } from './problem.ts';

export const pathParam = (req: Request, name: string): string => {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`path parameter "${name}" is required`);
  }
  return value;
};

export const queryString = (req: Request, name: string): string | undefined => {
  const raw = req.query[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
};
