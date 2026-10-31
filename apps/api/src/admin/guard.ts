import { timingSafeEqual } from 'node:crypto';

import { type PrismaClient } from '@app/db';
import { ADMIN_CSRF_HEADER, type AdminRole, ErrorCode } from '@app/shared';
import { type FastifyRequest } from 'fastify';

import { AppError } from '../errors.ts';
import { can, type Permission } from './rbac.ts';
import { ADMIN_COOKIE, type AdminSessions } from './sessions.ts';

export interface AdminContext {
  id: string;
  email: string;
  role: AdminRole;
  sessionId: string;
  csrf: string;
  totpEnabled: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminContext | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * preHandler factory: cookie session → active admin → CSRF header on mutations → permission.
 * Disabled admins lose access on their next request (the admin row is read every time).
 */
export function createAdminGuard(deps: { prisma: PrismaClient; sessions: AdminSessions }) {
  return (permission?: Permission) => async (request: FastifyRequest) => {
    const session = await deps.sessions.get(request.cookies[ADMIN_COOKIE]);
    if (session === null) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not signed in');
    const admin = await deps.prisma.adminUser.findUnique({ where: { id: session.adminId } });
    if (admin?.disabledAt !== null) {
      await deps.sessions.destroy(session.id);
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not signed in');
    }
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers[ADMIN_CSRF_HEADER];
      if (typeof header !== 'string' || !sameToken(header, session.csrf)) {
        throw new AppError(403, ErrorCode.CSRF_FAILED, 'Missing or invalid CSRF token');
      }
    }
    if (permission !== undefined && !can(admin.role, permission)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Not allowed for your role');
    }
    request.admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      sessionId: session.id,
      csrf: session.csrf,
      totpEnabled: admin.totpEnabled,
    };
  };
}

export type AdminGuard = ReturnType<typeof createAdminGuard>;

/** The admin of a guarded route (the guard guarantees it is set). */
export function adminOf(request: FastifyRequest): AdminContext {
  if (request.admin === null) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not signed in');
  return request.admin;
}
