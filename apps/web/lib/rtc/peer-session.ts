import { type PeerRole } from '@app/shared';

import { type CandidateType, deltaOf, qualityOf, readStats, type StatsSample } from './stats.ts';
import {
  type PeerState,
  type PeerSummary,
  type Quality,
  type RemoteParticipantView,
  type RtcSignal,
} from './types.ts';

export interface PeerSignaling {
  description(type: 'offer' | 'answer', sdp: string): void;
  candidate(candidate: RTCIceCandidateInit): void;
}

export interface PeerSessionOptions {
  sessionId: string;
  peer: PeerRole;
  /** Shared by every PeerSession of the call; never stopped here. */
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  /** Relay-only ICE (NEXT_PUBLIC_FORCE_TURN_RELAY): hides both sides' IP addresses. */
  forceRelay: boolean;
  signaling: PeerSignaling;
  /** State, quality or remote tracks changed. */
  onChange: () => void;
  /** Gave up: the connection failed again after an ICE restart. */
  onFailed: () => void;
  onError?: (message: string, error: unknown) => void;
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createMediaStream?: () => MediaStream;
  now?: () => number;
  maxVideoBitrateBps?: number;
  statsIntervalMs?: number;
  /** `disconnected` this long → ICE restart (initiator). */
  disconnectedRestartMs?: number;
  /** After the ICE restart that followed a failure, give up if not connected by then. */
  restartTimeoutMs?: number;
}

const DEFAULTS = {
  maxVideoBitrateBps: 800_000,
  statsIntervalMs: 2_000,
  disconnectedRestartMs: 3_000,
  restartTimeoutMs: 10_000,
} as const;

/** Bounds of the `rtc:summary` schema. */
const MAX_RTT_MS = 60_000;
const MAX_BITRATE_KBPS = 100_000;
const MAX_CONNECT_MS = 600_000;

interface Average {
  sum: number;
  count: number;
}

const averageOf = ({ sum, count }: Average, max: number) =>
  count === 0 ? null : Math.min(max, Math.round(sum / count));

/**
 * One RTCPeerConnection to one remote participant, framework-agnostic.
 *
 * Negotiation is "perfect negotiation" with the server-assigned roles: the initiator
 * (impolite) makes the first offer; the polite side waits for it and, in a collision,
 * rolls back and accepts the other offer. Signals are processed strictly in order.
 *
 * Restart policy: `disconnected` for 3 s → ICE restart by the initiator; `failed` → one ICE
 * restart (initiator; the polite side waits for it), and if the connection fails again or is
 * not back within 10 s, `onFailed` (the caller ends the session with `rtc_failed`). The budget
 * resets once connected again. A signaling (socket) reconnect never closes the connection.
 */
export class PeerSession {
  readonly sessionId: string;
  readonly participantId: string;
  readonly initiator: boolean;
  readonly polite: boolean;
  /** Remote media; our own object so it can be attached before any track arrives. */
  readonly remoteStream: MediaStream;

  private readonly pc: RTCPeerConnection;
  private readonly opts: PeerSessionOptions;
  private readonly now: () => number;
  private readonly startedAt: number;

  private state: PeerState = 'new';
  private quality: Quality | null = null;
  private closed = false;
  private finalSummary: PeerSummary | null = null;

  private makingOffer = false;
  private ignoreOffer = false;
  /** A remote description was applied at least once (the first offer/answer happened). */
  private negotiated = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private signals: Promise<void> = Promise.resolve();

  private failedRestartUsed = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly statsTimer: ReturnType<typeof setInterval>;

  private connectedAt: number | null = null;
  private lastSample: StatsSample | null = null;
  private candidates: { local: CandidateType; remote: CandidateType } = {
    local: 'unknown',
    remote: 'unknown',
  };
  private readonly rtt: Average = { sum: 0, count: 0 };
  private readonly bitrate: Average = { sum: 0, count: 0 };

  constructor(opts: PeerSessionOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.participantId = opts.peer.participantId;
    this.initiator = opts.peer.initiator;
    this.polite = opts.peer.polite;
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.remoteStream = (opts.createMediaStream ?? (() => new MediaStream()))();

    const create =
      opts.createPeerConnection ??
      ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
    const pc = create({
      iceServers: opts.iceServers,
      iceTransportPolicy: opts.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    // Handlers first — before any addTrack or setRemoteDescription — so no event is missed.
    pc.ontrack = (event) => {
      this.onTrack(event);
    };
    pc.onicecandidate = (event) => {
      this.onIceCandidate(event);
    };
    pc.onnegotiationneeded = () => {
      void this.negotiate();
    };
    pc.onconnectionstatechange = () => {
      this.onConnectionStateChange();
    };

    for (const track of opts.localStream.getTracks()) pc.addTrack(track, opts.localStream);

    this.statsTimer = setInterval(() => {
      void this.collectStats();
    }, opts.statsIntervalMs ?? DEFAULTS.statsIntervalMs);
  }

  /** Feeds an incoming signal; signals of other sessions or other senders are dropped. */
  handleSignal(signal: RtcSignal): Promise<void> {
    if (this.closed || signal.sessionId !== this.sessionId || signal.from !== this.participantId) {
      return Promise.resolve();
    }
    // One at a time, in arrival order: a description must be applied before what follows it.
    this.signals = this.signals.then(() =>
      signal.kind === 'ice'
        ? this.addCandidate(signal.candidate)
        : this.applyDescription(signal.kind, signal.sdp),
    );
    return this.signals;
  }

  /** ICE restart: new ICE credentials via a fresh offer (perfect negotiation applies). */
  restartIce(): void {
    if (this.closed) return;
    this.pc.restartIce();
  }

  /** Network or signaling path changed: restart ICE if this side drives it and it's needed. */
  recover(): void {
    if (this.closed || !this.negotiated || !this.initiator) return;
    if (this.state === 'reconnecting' || this.pc.connectionState === 'disconnected') {
      this.restartIce();
    }
  }

  /** New TURN credentials. A relayed connection re-allocates with them via an ICE restart. */
  setIceServers(iceServers: RTCIceServer[]): void {
    if (this.closed) return;
    this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    if (this.negotiated && this.candidates.local === 'relay') this.restartIce();
  }

  /** Swaps the outgoing track of the same kind (camera/mic change); no renegotiation. */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    if (this.closed) return;
    const sender = this.pc.getSenders().find((candidate) => candidate.track?.kind === track.kind);
    await sender?.replaceTrack(track);
  }

  view(): RemoteParticipantView {
    return {
      participantId: this.participantId,
      state: this.state,
      quality: this.quality,
      trackCount: this.remoteStream.getTracks().length,
    };
  }

  summary(): PeerSummary {
    if (this.finalSummary !== null) return this.finalSummary;
    return {
      peer: this.participantId,
      localCandidateType: this.candidates.local,
      remoteCandidateType: this.candidates.remote,
      avgRttMs: averageOf(this.rtt, MAX_RTT_MS),
      avgBitrateKbps: averageOf(this.bitrate, MAX_BITRATE_KBPS),
      timeToConnectedMs:
        this.connectedAt === null
          ? null
          : Math.min(MAX_CONNECT_MS, Math.round(this.connectedAt - this.startedAt)),
      failed: this.state === 'failed',
    };
  }

  /** Idempotent. Stops remote media and the connection; the local stream stays alive. */
  close(): PeerSummary {
    if (this.closed) return this.summary();
    this.finalSummary = this.summary();
    this.closed = true;
    this.state = 'closed';
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.restartTimer);
    clearInterval(this.statsTimer);
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    for (const track of this.remoteStream.getTracks()) this.remoteStream.removeTrack(track);
    this.pendingCandidates = [];
    return this.finalSummary;
  }

  // --- negotiation ------------------------------------------------------------------------

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    // The initiator makes the first offer. The polite side's own tracks are matched to the
    // m-lines of that offer, so it only renegotiates later (e.g. an ICE restart).
    if (!this.initiator && !this.negotiated) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription(); // creates the offer and applies it in one step
      const description = this.pc.localDescription;
      if (!this.isClosed() && description?.type === 'offer') {
        this.opts.signaling.description('offer', description.sdp);
      }
    } catch (error) {
      this.report('creating an offer failed', error);
    } finally {
      this.makingOffer = false;
    }
  }

  private async applyDescription(type: 'offer' | 'answer', sdp: string): Promise<void> {
    if (this.closed) return;
    const collision = type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return; // impolite: our offer wins
    try {
      // Polite side in a collision: setRemoteDescription rolls our offer back implicitly.
      await this.pc.setRemoteDescription({ type, sdp });
      if (this.isClosed()) return;
      this.negotiated = true;
      await this.flushCandidates();
      if (type === 'offer') {
        await this.pc.setLocalDescription(); // creates the answer and applies it
        const description = this.pc.localDescription;
        if (!this.isClosed() && description?.type === 'answer') {
          this.opts.signaling.description('answer', description.sdp);
        }
      }
    } catch (error) {
      this.report(`applying the remote ${type} failed`, error);
    }
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return;
    if (this.pc.remoteDescription === null) {
      this.pendingCandidates.push(candidate); // added once the remote description is set
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // Candidates for an offer we ignored are expected to fail.
      if (!this.ignoreOffer) this.report('adding an ICE candidate failed', error);
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) await this.addCandidate(candidate);
  }

  private onIceCandidate({ candidate }: RTCPeerConnectionIceEvent): void {
    // `null` = gathering finished; end-of-candidates is optional and not sent.
    if (this.closed || candidate === null) return;
    this.opts.signaling.candidate(candidate.toJSON());
  }

  private onTrack({ track }: RTCTrackEvent): void {
    if (this.closed) return;
    this.remoteStream.addTrack(track);
    this.opts.onChange();
  }

  // --- connection monitoring --------------------------------------------------------------

  private onConnectionStateChange(): void {
    if (this.closed) return;
    switch (this.pc.connectionState) {
      case 'connecting':
        if (this.state === 'new') this.setState('connecting');
        break;
      case 'connected':
        clearTimeout(this.disconnectTimer);
        clearTimeout(this.restartTimer);
        this.failedRestartUsed = false;
        if (this.connectedAt === null) {
          this.connectedAt = this.now();
          void this.capVideoBitrate();
        }
        this.setState('connected');
        break;
      case 'disconnected':
        this.setState('reconnecting');
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.initiator && this.pc.connectionState === 'disconnected') this.restartIce();
        }, this.opts.disconnectedRestartMs ?? DEFAULTS.disconnectedRestartMs);
        break;
      case 'failed':
        if (this.failedRestartUsed) {
          this.fail();
          break;
        }
        this.failedRestartUsed = true;
        this.setState('reconnecting');
        if (this.initiator) this.restartIce();
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.pc.connectionState !== 'connected') this.fail();
        }, this.opts.restartTimeoutMs ?? DEFAULTS.restartTimeoutMs);
        break;
      default:
        break;
    }
  }

  private fail(): void {
    if (this.closed || this.state === 'failed') return;
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.restartTimer);
    this.setState('failed');
    this.opts.onFailed();
  }

  private setState(state: PeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onChange();
  }

  /** ~800 kbps video cap; prefer keeping the frame rate when bandwidth drops. */
  private async capVideoBitrate(): Promise<void> {
    const maxBitrate = this.opts.maxVideoBitrateBps ?? DEFAULTS.maxVideoBitrateBps;
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      const encodings = parameters.encodings.length > 0 ? parameters.encodings : [{}];
      const capped: RTCRtpSendParameters = {
        ...parameters,
        encodings: encodings.map((encoding) => ({ ...encoding, maxBitrate })),
      };
      try {
        await sender.setParameters({ ...capped, degradationPreference: 'maintain-framerate' });
      } catch {
        // Some browsers reject degradationPreference; the bitrate cap alone still applies.
        try {
          await sender.setParameters(capped);
        } catch (error) {
          this.report('capping the video bitrate failed', error);
        }
      }
    }
  }

  private async collectStats(): Promise<void> {
    if (this.closed) return;
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return; // closed meanwhile
    }
    if (this.isClosed()) return;
    const sample = readStats(report, this.now());
    const delta = deltaOf(this.lastSample, sample);
    this.lastSample = sample;
    if (sample.localCandidateType !== 'unknown') {
      this.candidates = { local: sample.localCandidateType, remote: sample.remoteCandidateType };
    }
    if (this.state !== 'connected') return;
    if (delta.rttMs !== null) {
      this.rtt.sum += delta.rttMs;
      this.rtt.count += 1;
    }
    if (delta.sendKbps !== null) {
      this.bitrate.sum += delta.sendKbps;
      this.bitrate.count += 1;
    }
    const quality = qualityOf(delta);
    if (quality !== this.quality) {
      this.quality = quality;
      this.opts.onChange();
    }
  }

  /** Re-read after an await: `close()` may have run meanwhile (TS keeps the old narrowing). */
  private isClosed(): boolean {
    return this.closed;
  }

  private report(message: string, error: unknown): void {
    this.opts.onError?.(message, error);
  }
}
