import { describe, expect, it } from 'vitest';

import {
  chatMessageSchema,
  CLIENT_EVENTS,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_SDP_BYTES,
  moderationSignalSchema,
  pingSchema,
  queueJoinSchema,
  rtcDescriptionSchema,
  rtcIceSchema,
  rtcSummarySchema,
  SERVER_EVENTS,
} from '../index.ts';

const sessionId = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const to = 'p_AbCdEf12';

describe('socket contract', () => {
  it('exposes event-name constants (typed maps are checked by tsc)', () => {
    expect(Object.values(CLIENT_EVENTS)).toContain('rtc:ice');
    expect(Object.values(SERVER_EVENTS)).toContain('peer:left');
  });

  it('normalizes queue:join and defaults interests', () => {
    expect(queueJoinSchema.parse({ mode: 'video', lang: 'en' })).toEqual({
      mode: 'video',
      lang: 'en',
      interests: [],
    });
    expect(
      queueJoinSchema.parse({ mode: 'text', lang: 'de', interests: [' Music', 'music'] }).interests,
    ).toEqual(['music']);
    expect(queueJoinSchema.safeParse({ mode: 'audio', lang: 'en' }).success).toBe(false);
  });

  it('accepts an empty/missing payload for ping', () => {
    expect(pingSchema.parse(undefined)).toEqual({});
    expect(pingSchema.parse({})).toEqual({});
  });

  it('bounds chat text and requires a session id', () => {
    expect(
      chatMessageSchema.safeParse({ sessionId, text: '  hi ', clientMsgId: 'c1' }).success,
    ).toBe(true);
    expect(
      chatMessageSchema.safeParse({ sessionId: 'x', text: 'hi', clientMsgId: 'c1' }).success,
    ).toBe(false);
  });

  it('limits SDP and ICE sizes and participant id format', () => {
    expect(rtcDescriptionSchema.safeParse({ sessionId, to, sdp: 'v=0' }).success).toBe(true);
    expect(
      rtcDescriptionSchema.safeParse({ sessionId, to, sdp: 'x'.repeat(MAX_SDP_BYTES + 1) }).success,
    ).toBe(false);
    expect(
      rtcDescriptionSchema.safeParse({ sessionId, to: 'visitor-uuid-with-braces{}', sdp: 'v=0' })
        .success,
    ).toBe(false);
    expect(
      rtcIceSchema.safeParse({
        sessionId,
        to,
        candidate: { candidate: 'x'.repeat(MAX_ICE_CANDIDATE_LENGTH + 1) },
      }).success,
    ).toBe(false);
    expect(
      rtcIceSchema.safeParse({ sessionId, to, candidate: { candidate: '', sdpMid: null } }).success,
    ).toBe(true);
  });

  it('validates rtc summaries and moderation signals', () => {
    expect(
      rtcSummarySchema.safeParse({
        sessionId,
        peer: to,
        localCandidateType: 'relay',
        remoteCandidateType: 'srflx',
        avgRttMs: 42,
        avgBitrateKbps: null,
        timeToConnectedMs: 900,
        failed: false,
      }).success,
    ).toBe(true);
    expect(
      moderationSignalSchema.safeParse({ sessionId, about: 'self', kind: 'nudity', score: 0.4 })
        .success,
    ).toBe(true);
    expect(
      moderationSignalSchema.safeParse({ sessionId, about: to, kind: 'nudity', score: 1.5 })
        .success,
    ).toBe(false);
  });
});
