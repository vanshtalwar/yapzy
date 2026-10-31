import { type ReportReason } from '@app/shared';

/** Review order: child safety first, then sexual content, violence, hate, ... */
const BASE_PRIORITY: Record<ReportReason, number> = {
  MINOR_SAFETY: 100,
  NUDITY_SEXUAL: 80,
  VIOLENCE_SELF_HARM: 70,
  HATE: 60,
  HARASSMENT: 50,
  SPAM_SCAM: 30,
  OTHER: 10,
};

/** Boost per other report against the same visitor in the last 24 h (repeat offenders). */
const REPEAT_BOOST = 10;
const MAX_REPEAT_BOOST = 30;

export function reportPriority(reason: ReportReason, recentReportsAgainst: number): number {
  return BASE_PRIORITY[reason] + Math.min(MAX_REPEAT_BOOST, REPEAT_BOOST * recentReportsAgainst);
}

/** Report evidence is kept this long after the report (then purged; see CONTEXT.md). */
export const EVIDENCE_RETENTION_DAYS = 90;
