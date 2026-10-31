import { type AdminRole, MODERATOR_MAX_HARD_BAN_HOURS } from '@app/shared';

/**
 * RBAC matrix (Part 9): MODERATORs review reports, dismiss, shadow-ban and hard-ban for at
 * most 30 days; ADMINs can do everything (permanent bans, revocations, audit log, admins).
 */
const MATRIX = {
  'stats.read': ['ADMIN', 'MODERATOR'],
  'reports.read': ['ADMIN', 'MODERATOR'],
  'reports.review': ['ADMIN', 'MODERATOR'],
  'bans.read': ['ADMIN', 'MODERATOR'],
  'bans.create': ['ADMIN', 'MODERATOR'],
  'bans.revoke': ['ADMIN'],
  'trust.adjust': ['ADMIN', 'MODERATOR'],
  'events.read': ['ADMIN', 'MODERATOR'],
  'visitors.read': ['ADMIN', 'MODERATOR'],
  'audit.read': ['ADMIN'],
  'admins.manage': ['ADMIN'],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: AdminRole, permission: Permission): boolean {
  return (MATRIX[permission] as readonly AdminRole[]).includes(role);
}

/** Ban limits by role: shadow bans for everyone, hard bans ≤ 30 days unless ADMIN. */
export function canBan(
  role: AdminRole,
  ban: { type: 'HARD' | 'SHADOW'; durationHours: number | null },
): boolean {
  if (ban.type === 'SHADOW' || role === 'ADMIN') return true;
  return ban.durationHours !== null && ban.durationHours <= MODERATOR_MAX_HARD_BAN_HOURS;
}
