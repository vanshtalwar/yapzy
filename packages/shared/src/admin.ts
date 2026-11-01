// REST contract of /v1/admin/* (apps/api ↔ apps/admin). Browser-safe.
import { z } from 'zod';

import { REPORT_REASONS } from './rest.ts';

export const ADMIN_ROLES = ['ADMIN', 'MODERATOR'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const REPORT_STATUSES = ['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'] as const;
export const BAN_TYPES = ['HARD', 'SHADOW'] as const;
export const MODERATION_EVENT_SOURCES = [
  'CLIENT_NSFW',
  'SERVER_CLASSIFIER',
  'TEXT_FILTER',
  'HASH_MATCH',
  'REPORT_THRESHOLD',
] as const;

/** Header carrying the session's CSRF token on every mutating admin request. */
export const ADMIN_CSRF_HEADER = 'x-admin-csrf';
/** MODERATORs may hard-ban for at most this long (ADMINs: any duration, permanent). */
export const MODERATOR_MAX_HARD_BAN_HOURS = 30 * 24;

const iso = z.iso.datetime();
const id = z.uuid();
const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// --- auth ---------------------------------------------------------------------------------

export const adminLoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type AdminLogin = z.input<typeof adminLoginSchema>;

export const adminMeSchema = z.object({
  id,
  email: z.string(),
  role: z.enum(ADMIN_ROLES),
  totpEnabled: z.boolean(),
  /** Production: everything except enrolment is refused until `totpEnabled`. */
  totpRequired: z.boolean(),
  /** Send back in `x-admin-csrf` on every POST. */
  csrfToken: z.string(),
});
export type AdminMe = z.output<typeof adminMeSchema>;

export const totpSetupResponseSchema = z.object({
  otpauthUrl: z.string(),
  /** PNG data URL of the QR code (self-contained; no third-party QR service). */
  qrDataUrl: z.string().startsWith('data:image/png;base64,'),
});
export const totpVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

// --- shared views -------------------------------------------------------------------------

export const banViewSchema = z.object({
  id,
  visitorId: id.nullable(),
  type: z.enum(BAN_TYPES),
  reason: z.string(),
  expiresAt: iso.nullable(),
  revokedAt: iso.nullable(),
  createdAt: iso,
  createdBy: z.string().nullable(),
  /** Not revoked and not expired at response time. */
  active: z.boolean(),
});
export type BanView = z.output<typeof banViewSchema>;

export const moderationEventViewSchema = z.object({
  id,
  visitorId: id,
  sessionId: id.nullable(),
  source: z.enum(MODERATION_EVENT_SOURCES),
  label: z.string(),
  score: z.number(),
  actionTaken: z.string(),
  createdAt: iso,
});
export type ModerationEventView = z.output<typeof moderationEventViewSchema>;

export const visitorProfileSchema = z.object({
  id,
  trustScore: z.number().int(),
  firstSeenAt: iso,
  lastSeenAt: iso,
  country: z.string().nullable(),
  sessions: z.number().int(),
  reportsReceived: z.number().int(),
  reportsReceived30d: z.number().int(),
  reportsFiled: z.number().int(),
  bans: z.array(banViewSchema),
  events: z.array(moderationEventViewSchema),
  recentReports: z.array(
    z.object({
      id,
      reason: z.enum(REPORT_REASONS),
      status: z.enum(REPORT_STATUSES),
      createdAt: iso,
    }),
  ),
});
export type VisitorProfile = z.output<typeof visitorProfileSchema>;

// --- reports ------------------------------------------------------------------------------

export const reportListItemSchema = z.object({
  id,
  reason: z.enum(REPORT_REASONS),
  status: z.enum(REPORT_STATUSES),
  priority: z.number().int(),
  automatic: z.boolean(),
  reportedId: id,
  evidenceCount: z.number().int(),
  assignedTo: z.string().nullable(),
  createdAt: iso,
});
export type ReportListItem = z.output<typeof reportListItemSchema>;
export const reportPageSchema = page(reportListItemSchema);

export const reportQuerySchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  reason: z.enum(REPORT_REASONS).optional(),
  minPriority: z.coerce.number().int().min(0).optional(),
  from: iso.optional(),
  to: iso.optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const transcriptLineSchema = z.object({
  id: z.string().optional(),
  at: z.string().optional(),
  /** `reporter` | `reported` | `other` (automatic reports before Part 12: a participant id). */
  from: z.string().optional(),
  /** Who sent it, so group-call lines map onto `participants` (missing before Part 12). */
  participantId: z.string().optional(),
  text: z.string().optional(),
});

export const REPORT_PARTICIPANT_ROLES = ['reporter', 'reported', 'other'] as const;
/** Someone in the reported chat (group calls: up to four), in join order. */
export const reportParticipantSchema = z.object({
  participantId: z.string(),
  visitorId: z.string(),
  role: z.enum(REPORT_PARTICIPANT_ROLES),
  /** "Reporter", "Reported", then "Other 1", "Other 2"… */
  label: z.string(),
  joinedAt: iso.nullable(),
  leftAt: iso.nullable(),
  leaveReason: z.string().nullable(),
});
export type ReportParticipant = z.output<typeof reportParticipantSchema>;

export const evidenceViewSchema = z.object({
  id,
  type: z.enum(['FRAME', 'TRANSCRIPT', 'AUTO_FLAG_FRAME']),
  sha256: z.string(),
  /** Presigned GET URL, valid for 5 minutes. */
  url: z.string().nullable(),
  expiresAt: iso.nullable(),
});

export const reportDetailSchema = reportListItemSchema.extend({
  sessionId: id,
  reportedParticipantId: z.string(),
  details: z.string().nullable(),
  transcript: z.array(transcriptLineSchema),
  participants: z.array(reportParticipantSchema),
  evidence: z.array(evidenceViewSchema),
  resolutionNote: z.string().nullable(),
  resolvedAt: iso.nullable(),
  reporter: visitorProfileSchema.nullable(),
  reported: visitorProfileSchema,
});
export type ReportDetail = z.output<typeof reportDetailSchema>;

export const banRequestSchema = z.object({
  type: z.enum(BAN_TYPES),
  /** null = permanent (ADMIN only for HARD bans). */
  durationHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365 * 10)
    .nullable(),
});

export const reportActionSchema = z.object({
  ban: banRequestSchema.optional(),
  trustDelta: z.number().int().min(-50).max(50).optional(),
  note: z.string().trim().max(2_000).optional(),
});
export const reportDismissSchema = z.object({ note: z.string().trim().max(2_000).optional() });
export const reportNoteSchema = z.object({ note: z.string().trim().min(1).max(2_000) });

// --- bans, events, audit, admins ----------------------------------------------------------

export const banQuerySchema = z.object({
  visitorId: id.optional(),
  active: z.stringbool().optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const banPageSchema = page(banViewSchema);
export const createBanSchema = banRequestSchema.extend({
  visitorId: id,
  reason: z.string().trim().min(3).max(500),
});

export const eventQuerySchema = z.object({
  source: z.enum(MODERATION_EVENT_SOURCES).optional(),
  visitorId: id.optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const eventPageSchema = page(moderationEventViewSchema);

export const auditEntrySchema = z.object({
  id,
  adminEmail: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.unknown(),
  createdAt: iso,
});
export const auditQuerySchema = z.object({
  action: z.string().max(64).optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const auditPageSchema = page(auditEntrySchema);

export const adminUserSchema = z.object({
  id,
  email: z.string(),
  role: z.enum(ADMIN_ROLES),
  totpEnabled: z.boolean(),
  lastLoginAt: iso.nullable(),
  disabledAt: iso.nullable(),
  createdAt: iso,
});
export const adminUserListSchema = z.object({ items: z.array(adminUserSchema) });
export const createAdminSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(256),
  role: z.enum(ADMIN_ROLES),
});

// --- live stats ---------------------------------------------------------------------------

export const adminStatsSchema = z.object({
  online: z.number().int(),
  activeSessions: z.number().int(),
  /** Waiting visitors per `<pool>:<mode>:<lang>`. */
  waiting: z.record(z.string(), z.number().int()),
  /** Matches per minute, oldest first, last 60 minutes (UTC minute starts). */
  matchesPerMinute: z.array(z.object({ minute: iso, count: z.number().int() })),
  openReports: z.object({
    total: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }),
});
export type AdminStats = z.output<typeof adminStatsSchema>;

export const okSchema = z.object({ ok: z.literal(true) });
