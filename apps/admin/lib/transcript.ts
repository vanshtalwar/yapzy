import { type ReportDetail } from '@app/shared';

type Line = ReportDetail['transcript'][number];
export type Author = Pick<ReportDetail['participants'][number], 'label' | 'role'>;

/**
 * Who sent a transcript line: the participant it names (group calls: "Other 1"…), else its
 * role — reports from before Part 12 have no `participantId`, and older automatic reports
 * stored the sender's participant id in `from`.
 */
export function authorOf(
  line: Line,
  report: Pick<ReportDetail, 'participants' | 'reportedParticipantId'>,
): Author {
  const known = report.participants.find((p) => p.participantId === line.participantId);
  if (known !== undefined) return known;
  if (line.from === 'reported' || line.from === report.reportedParticipantId) {
    return { label: 'Reported', role: 'reported' };
  }
  if (line.from === 'reporter') return { label: 'Reporter', role: 'reporter' };
  return { label: 'Other', role: 'other' };
}
