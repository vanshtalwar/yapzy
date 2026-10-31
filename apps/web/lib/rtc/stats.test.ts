import { describe, expect, it } from 'vitest';

import { deltaOf, qualityOf, readStats } from './stats.ts';

function report(entries: Record<string, Record<string, unknown>>): RTCStatsReport {
  return new Map(Object.entries(entries));
}

const base = {
  T1: { type: 'transport', selectedCandidatePairId: 'CP1' },
  CP1: {
    type: 'candidate-pair',
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    currentRoundTripTime: 0.042,
  },
  L1: { type: 'local-candidate', candidateType: 'relay', address: '203.0.113.7' },
  R1: { type: 'remote-candidate', candidateType: 'srflx' },
};

describe('stats', () => {
  it('reads the selected pair (types only, no addresses) and RTP counters', () => {
    const sample = readStats(
      report({
        ...base,
        O1: { type: 'outbound-rtp', bytesSent: 100_000 },
        O2: { type: 'outbound-rtp', bytesSent: 20_000 },
        I1: { type: 'inbound-rtp', bytesReceived: 50_000, packetsReceived: 900, packetsLost: 10 },
      }),
      1_000,
    );
    expect(sample).toEqual({
      at: 1_000,
      rttMs: 42,
      localCandidateType: 'relay',
      remoteCandidateType: 'srflx',
      bytesSent: 120_000,
      bytesReceived: 50_000,
      packetsReceived: 900,
      packetsLost: 10,
    });
  });

  it('falls back to the nominated pair without transport stats, unknown without any', () => {
    const { T1: _transport, ...noTransport } = base;
    const pair = { ...base.CP1, nominated: true, state: 'succeeded' };
    expect(readStats(report({ ...noTransport, CP1: pair }), 0).localCandidateType).toBe('relay');
    expect(readStats(report({}), 0)).toMatchObject({
      rttMs: null,
      localCandidateType: 'unknown',
      remoteCandidateType: 'unknown',
    });
  });

  it('turns two samples into rates and loss, and grades the connection', () => {
    const first = readStats(
      report({
        ...base,
        I1: { type: 'inbound-rtp', bytesReceived: 0, packetsReceived: 0, packetsLost: 0 },
      }),
      0,
    );
    const second = readStats(
      report({
        ...base,
        O1: { type: 'outbound-rtp', bytesSent: 200_000 },
        I1: { type: 'inbound-rtp', bytesReceived: 100_000, packetsReceived: 950, packetsLost: 50 },
      }),
      2_000,
    );
    const delta = deltaOf(first, second);
    expect(delta).toEqual({ rttMs: 42, lossRatio: 0.05, sendKbps: 800, receiveKbps: 400 });
    expect(qualityOf(delta)).toBe('fair');
    expect(qualityOf({ ...delta, lossRatio: 0.01 })).toBe('good');
    expect(qualityOf({ ...delta, rttMs: 800 })).toBe('poor');
    expect(deltaOf(null, second)).toEqual({
      rttMs: 42,
      lossRatio: null,
      sendKbps: null,
      receiveKbps: null,
    });
  });
});
