import type { UserRole } from '../infra/db/types.ts';

export interface AuthPrincipal {
  id: string;
  role: UserRole;
  email?: string;
  via: 'jwt' | 'api-key';
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      principal?: AuthPrincipal;
      startedAt?: bigint;
    }
  }
}
