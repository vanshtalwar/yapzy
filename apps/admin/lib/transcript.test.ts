import { type ReportParticipant } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { authorOf } from './transcript.ts';

const participant = (participantId: string, role: ReportParticipant['role'], label: string) => ({
  participantId,
  visitorId: `v-${participantId}`,
  role,
  label,
  joinedAt: null,
  leftAt: null,
  leaveReason: null,
});

describe('transcript authors', () => {
  const report = {
    reportedParticipantId: 'pReported001',
    participants: [
      participant('pReporter001', 'reporter', 'Reporter'),
      participant('pReported001', 'reported', 'Reported'),
      participant('pOther000001', 'other', 'Other 1'),
      participant('pOther000002', 'other', 'Other 2'),
    ],
  };

  it('names the sender of group-call lines', () => {
    expect(authorOf({ from: 'other', participantId: 'pOther000002' }, report)).toEqual(
      expect.objectContaining({ label: 'Other 2', role: 'other' }),
    );
    expect(authorOf({ from: 'reported', participantId: 'pReported001' }, report)).toEqual(
      expect.objectContaining({ label: 'Reported', role: 'reported' }),
    );
  });

  it('falls back to the role for older reports and unknown senders', () => {
    const none = { ...report, participants: [] };
    expect(authorOf({ from: 'reporter' }, none)).toEqual({ label: 'Reporter', role: 'reporter' });
    expect(authorOf({ from: 'reported' }, none)).toEqual({ label: 'Reported', role: 'reported' });
    // Automatic reports before Part 12 stored the sender's participant id in `from`.
    expect(authorOf({ from: 'pReported001' }, none)).toEqual({
      label: 'Reported',
      role: 'reported',
    });
    expect(authorOf({ from: 'pSomeone0001' }, none)).toEqual({ label: 'Other', role: 'other' });
    expect(authorOf({ from: 'other', participantId: 'pGone0000001' }, report)).toEqual({
      label: 'Other',
      role: 'other',
    });
  });
});
