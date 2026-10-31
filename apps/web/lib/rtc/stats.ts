import { CANDIDATE_TYPES } from '@app/shared';

import { type Quality } from './types.ts';

export type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** Cumulative counters from one `getStats()` report. */
export interface StatsSample {
  at: number;
  rttMs: number | null;
  localCandidateType: CandidateType;
  remoteCandidateType: CandidateType;
  bytesSent: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
}

/** What changed between two samples. */
export interface StatsDelta {
  rttMs: number | null;
  /** Inbound packet loss over the interval, 0–1. */
  lossRatio: number | null;
  sendKbps: number | null;
  receiveKbps: number | null;
}

type Stat = Record<string, unknown>;

const num = (stat: Stat | undefined, key: string): number | null => {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
const str = (stat: Stat | undefined, key: string): string | null => {
  const value = stat?.[key];
  return typeof value === 'string' ? value : null;
};
const candidateType = (stat: Stat | undefined): CandidateType => {
  const type = str(stat, 'candidateType');
  return CANDIDATE_TYPES.find((known) => known === type) ?? 'unknown';
};

/** Reads the selected candidate pair and RTP byte/packet counters (no addresses kept). */
export function readStats(report: RTCStatsReport, at: number): StatsSample {
  const stats = new Map<string, Stat>();
  report.forEach((value: Stat, id: string) => stats.set(id, value));

  let pair: Stat | undefined;
  for (const stat of stats.values()) {
    const selected = str(stat, 'selectedCandidatePairId');
    if (str(stat, 'type') === 'transport' && selected !== null) pair = stats.get(selected);
  }
  // Firefox has no transport stats: fall back to the nominated, succeeded pair.
  pair ??= [...stats.values()].find(
    (stat) =>
      str(stat, 'type') === 'candidate-pair' &&
      (stat.selected === true || (stat.nominated === true && stat.state === 'succeeded')),
  );

  const sample: StatsSample = {
    at,
    rttMs: null,
    localCandidateType: 'unknown',
    remoteCandidateType: 'unknown',
    bytesSent: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
  };
  if (pair !== undefined) {
    const rtt = num(pair, 'currentRoundTripTime');
    sample.rttMs = rtt === null ? null : Math.round(rtt * 1000);
    sample.localCandidateType = candidateType(stats.get(str(pair, 'localCandidateId') ?? ''));
    sample.remoteCandidateType = candidateType(stats.get(str(pair, 'remoteCandidateId') ?? ''));
  }
  for (const stat of stats.values()) {
    const type = str(stat, 'type');
    if (type === 'outbound-rtp') sample.bytesSent += num(stat, 'bytesSent') ?? 0;
    if (type === 'inbound-rtp') {
      sample.bytesReceived += num(stat, 'bytesReceived') ?? 0;
      sample.packetsReceived += num(stat, 'packetsReceived') ?? 0;
      sample.packetsLost += Math.max(0, num(stat, 'packetsLost') ?? 0);
    }
  }
  return sample;
}

export function deltaOf(previous: StatsSample | null, next: StatsSample): StatsDelta {
  if (previous === null || next.at <= previous.at) {
    return { rttMs: next.rttMs, lossRatio: null, sendKbps: null, receiveKbps: null };
  }
  const seconds = (next.at - previous.at) / 1000;
  const kbps = (bytes: number) => (bytes < 0 ? null : Math.round((bytes * 8) / 1000 / seconds));
  const received = next.packetsReceived - previous.packetsReceived;
  const lost = next.packetsLost - previous.packetsLost;
  return {
    rttMs: next.rttMs,
    lossRatio: received + lost > 0 && lost >= 0 ? lost / (received + lost) : null,
    sendKbps: kbps(next.bytesSent - previous.bytesSent),
    receiveKbps: kbps(next.bytesReceived - previous.bytesReceived),
  };
}

/** Thresholds for the badge: loss hurts video first, RTT hurts conversation. */
export function qualityOf({ rttMs, lossRatio }: StatsDelta): Quality {
  if ((lossRatio ?? 0) > 0.08 || (rttMs ?? 0) > 500) return 'poor';
  if ((lossRatio ?? 0) > 0.03 || (rttMs ?? 0) > 250) return 'fair';
  return 'good';
}
