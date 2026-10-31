import { type ReportReason } from '@app/shared';

export const REASON_LABELS: Record<ReportReason, string> = {
  MINOR_SAFETY: 'Minor safety',
  NUDITY_SEXUAL: 'Nudity / sexual',
  VIOLENCE_SELF_HARM: 'Violence / self-harm',
  HATE: 'Hate',
  HARASSMENT: 'Harassment',
  SPAM_SCAM: 'Spam / scam',
  OTHER: 'Other',
};

export const STATUS_LABELS = {
  OPEN: 'Open',
  IN_REVIEW: 'In review',
  ACTIONED: 'Actioned',
  DISMISSED: 'Dismissed',
} as const;

/** Ban duration presets (hours; null = permanent, ADMIN only for hard bans). */
export const BAN_DURATIONS: { label: string; hours: number | null }[] = [
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: 'Permanent', hours: null },
];

export function priorityTone(priority: number): 'danger' | 'warning' | 'muted' {
  if (priority >= 80) return 'danger';
  if (priority >= 50) return 'warning';
  return 'muted';
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export const shortId = (id: string) => id.slice(0, 8);
