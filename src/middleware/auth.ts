import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Collections } from '../infra/db/collections.ts';
import type { UserRole } from '../infra/db/types.ts';
import type { TokenService } from '../modules/auth/service.ts';
import { sha256Hex } from '../shared/hash.ts';
import { forbidden, unauthorized } from '../shared/problem.ts';

export interface AuthDeps {
  tokens: TokenService;
  collections: Collections;
}

const bearerToken = (req: Request): string | null => {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
};

export const createAuthMiddleware = (deps: AuthDeps): RequestHandler => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req);
      if (token) {
        const claims = await deps.tokens.verifyAccessToken(token);
        req.principal = { id: claims.sub, role: claims.role, via: 'jwt' };
        next();
        return;
      }

      const apiKey = req.header('x-api-key');
      if (apiKey) {
        const record = await deps.collections.apiKeys.findOne({
          keyHash: sha256Hex(apiKey),
          active: true,
        });
        if (!record) throw unauthorized('API key is invalid or revoked');
        if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
          throw unauthorized('API key has expired');
        }
        const owner = await deps.collections.users.findOne({ _id: record.ownerId });
        if (!owner) throw unauthorized('API key owner no longer exists');
        req.principal = { id: owner._id, role: owner.role, via: 'api-key' };
        next();
        return;
      }

      throw unauthorized('Authentication required');
    } catch (error) {
      next(error);
    }
  };
};

export const optionalAuth = (deps: AuthDeps): RequestHandler => {
  const inner = createAuthMiddleware(deps);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.header('authorization') && !req.header('x-api-key')) {
      next();
      return;
    }
    inner(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      next();
    });
  };
};

export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.principal) {
      next(unauthorized('Authentication required'));
      return;
    }
    if (!roles.includes(req.principal.role)) {
      next(forbidden(`Requires role: ${roles.join(' or ')}`));
      return;
    }
    next();
  };

export const requireOwner = (req: Request, ownerId: string): void => {
  if (!req.principal) throw unauthorized('Authentication required');
  if (req.principal.role === 'admin') return;
  if (req.principal.id !== ownerId) throw forbidden('You do not own this resource');
};

export const requireDebugAccess = (deps: {
  debugEnabled: boolean;
  debugToken?: string;
}): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!deps.debugEnabled) {
      next(forbidden('Debug endpoints are disabled'));
      return;
    }
    const provided = req.header('x-debug-token');
    if (deps.debugToken && provided !== deps.debugToken) {
      next(unauthorized('Debug token is invalid'));
      return;
    }
    if (!req.principal) {
      next(unauthorized('Admin authentication required'));
      return;
    }
    if (req.principal.role !== 'admin') {
      next(forbidden('Admin role required for debug endpoints'));
      return;
    }
    next();
  };
};
