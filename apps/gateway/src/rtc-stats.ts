import { CANDIDATE_TYPES, type RtcSummaryPayload } from '@app/shared';

import { type GatewayMetrics } from './metrics.ts';

type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** Running sum + count, so averages can be derived (and exported as Prometheus summaries). */
interface Total {
  sum: number;
  count: number;
}

export interface RtcStatsSnapshot {
  summaries: number;
  failed: number;
  /** Peer connections whose selected local candidate was relayed through TURN. */
  relayed: number;
  localCandidates: Record<CandidateType, number>;
  timeToConnectedMs: Total;
  rttMs: Total;
  bitrateKbps: Total;
}

type RtcMetrics = Pick<
  GatewayMetrics,
  'rtcSummaries' | 'rtcLocalCandidates' | 'rtcTimeToConnected' | 'rtcRtt'
>;

/**
 * Node-local counters from `rtc:summary` (one per peer connection, sent by each side), also
 * exported as Prometheus metrics (connected %, relay %, time to connected, RTT); nothing here
 * identifies a visitor.
 */
export function createRtcStats(metrics?: RtcMetrics) {
  const zeroByType = () =>
    Object.fromEntries(CANDIDATE_TYPES.map((type) => [type, 0])) as Record<CandidateType, number>;
  const state: RtcStatsSnapshot = {
    summaries: 0,
    failed: 0,
    relayed: 0,
    localCandidates: zeroByType(),
    timeToConnectedMs: { sum: 0, count: 0 },
    rttMs: { sum: 0, count: 0 },
    bitrateKbps: { sum: 0, count: 0 },
  };

  const add = (total: Total, value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    total.sum += value;
    total.count += 1;
  };

  return {
    record(summary: RtcSummaryPayload): void {
      state.summaries += 1;
      if (summary.failed) state.failed += 1;
      if (summary.localCandidateType === 'relay') state.relayed += 1;
      state.localCandidates[summary.localCandidateType] += 1;
      add(state.timeToConnectedMs, summary.timeToConnectedMs);
      add(state.rttMs, summary.avgRttMs);
      add(state.bitrateKbps, summary.avgBitrateKbps);
      if (metrics === undefined) return;
      metrics.rtcSummaries.inc({ outcome: summary.failed ? 'failed' : 'connected' });
      metrics.rtcLocalCandidates.inc({ type: summary.localCandidateType });
      if (summary.timeToConnectedMs != null) {
        metrics.rtcTimeToConnected.observe(summary.timeToConnectedMs / 1_000);
      }
      if (summary.avgRttMs != null) metrics.rtcRtt.observe(summary.avgRttMs / 1_000);
    },

    snapshot(): RtcStatsSnapshot {
      return structuredClone(state);
    },
  };
}

export type RtcStats = ReturnType<typeof createRtcStats>;
