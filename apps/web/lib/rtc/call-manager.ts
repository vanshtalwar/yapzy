import { type PeerRole, type SfuJoin } from '@app/shared';

import { MeshTransport, type MeshTransportOptions } from './mesh-transport.ts';
import { SfuTransport, type SfuTransportOptions } from './sfu-transport.ts';
import {
  type CallSignaling,
  type CallTransport,
  type CallView,
  type PeerSummary,
  type RtcSignal,
} from './types.ts';

export interface CallManagerOptions {
  sessionId: string;
  selfParticipantId: string;
  peers: PeerRole[];
  /** Set when the call starts on Janus (DEV_FORCE_SFU, a joiner in Part 12). */
  sfu?: SfuJoin;
  /** Acquired once per tab and shared by every call; a call never stops it. */
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  signaling: CallSignaling;
  /** Plain snapshot for React, coalesced per microtask. */
  onChange: (view: CallView) => void;
  /** A participant's media could not be (re)established. */
  onFailed: (participantId: string | null) => void;
  /** Every participant now arrives through the room of `epoch`: send `call:topologyReady`. */
  onTopologyReady?: (epoch: number) => void;
  /** A fresh Janus API token for the room of `epoch` (`call:sfuToken`). */
  refreshSfuToken?: (epoch: number) => Promise<string | null>;
  /** The `rtc:summary` payloads of connections closed by a switch. */
  onSummaries?: (summaries: PeerSummary[]) => void;
  onError?: (message: string, error: unknown) => void;
  createTransport?: (options: MeshTransportOptions) => CallTransport;
  createSfuTransport?: (options: SfuTransportOptions) => CallTransport & { readonly epoch: number };
}

type SfuLike = CallTransport & { readonly epoch: number };

/**
 * One per chat session. Owns the media transport(s) and is the only thing the UI asks for
 * remote participants and their streams.
 *
 * Make-before-break (Part 11): on `call:topology` the current transport keeps playing while a
 * Janus transport joins the room; only when every participant's media arrives through Janus
 * are the tiles swapped, the old connections closed and `call:topologyReady` sent. A rollback
 * closes the Janus side and P2P carries on. The same swap moves a call to a new Janus room on
 * failover.
 */
export class CallManager {
  readonly sessionId: string;
  private active: CallTransport;
  private pending: SfuLike | null = null;
  private readonly peers = new Map<string, PeerRole>();
  private readonly opts: CallManagerOptions;
  private closed = false;
  private changeQueued = false;
  private iceServers: RTCIceServer[];
  private readonly quality = new Map<string, 'high' | 'low'>();

  constructor(opts: CallManagerOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.iceServers = opts.iceServers;
    for (const peer of opts.peers) this.peers.set(peer.participantId, peer);
    if (opts.sfu === undefined) {
      const create = opts.createTransport ?? ((options) => new MeshTransport(options));
      this.active = create({
        sessionId: opts.sessionId,
        localStream: opts.localStream,
        iceServers: opts.iceServers,
        forceRelay: opts.forceRelay,
        signaling: opts.signaling,
        onChange: () => {
          this.queueChange();
        },
        onFailed: (participantId) => {
          if (!this.closed) opts.onFailed(participantId);
        },
        ...(opts.onError === undefined ? {} : { onError: opts.onError }),
      });
    } else {
      this.active = this.createSfu(opts.sfu, { activeFromStart: true });
    }
    for (const peer of this.peers.values()) this.active.addPeer(peer);
  }

  get topology(): 'mesh' | 'sfu' {
    return this.active.topology;
  }

  /** Epoch of the Janus room being joined or in use (null while P2P only). */
  get sfuEpoch(): number | null {
    if (this.pending !== null) return this.pending.epoch;
    return this.active.topology === 'sfu' ? (this.active as SfuLike).epoch : null;
  }

  /** Signals of another session (a call the user already left) are dropped. */
  handleSignal(signal: RtcSignal): void {
    if (this.closed || signal.sessionId !== this.sessionId) return;
    this.active.handleSignal(signal);
  }

  /** A new participant (group calls, Part 12): every transport starts expecting them. */
  addPeer(peer: PeerRole): void {
    if (this.closed || this.peers.has(peer.participantId)) return;
    this.peers.set(peer.participantId, peer);
    this.active.addPeer(peer);
    this.pending?.addPeer(peer);
    this.queueChange();
  }

  removePeer(participantId: string): PeerSummary | null {
    if (this.closed) return null;
    this.peers.delete(participantId);
    this.pending?.removePeer(participantId);
    return this.active.removePeer(participantId);
  }

  remoteStream(participantId: string): MediaStream | null {
    return this.closed ? null : this.active.remoteStream(participantId);
  }

  view(): CallView {
    return {
      sessionId: this.sessionId,
      topology: this.active.topology,
      participants: this.closed ? [] : this.active.participants(),
      switching: this.pending !== null,
      epoch: this.active.topology === 'sfu' ? (this.active as SfuLike).epoch : 0,
    };
  }

  /**
   * `call:topology` (sfu) / a resume naming a room: join it unless this epoch is already in
   * use or being joined. A newer epoch replaces a pending older one.
   */
  switchToSfu(join: SfuJoin): void {
    if (this.closed || this.sfuEpoch === join.epoch) return;
    if (this.sfuEpoch !== null && join.epoch < this.sfuEpoch) return;
    if (this.pending !== null) this.reportSummaries(this.pending.close());
    this.pending = this.createSfu(join, { activeFromStart: false });
    for (const peer of this.peers.values()) this.pending.addPeer(peer);
    this.queueChange();
  }

  /** `call:topology` (mesh): the switch of `epoch` was rolled back — keep the current media. */
  rollback(epoch: number): void {
    if (this.pending?.epoch !== epoch) return;
    this.reportSummaries(this.pending.close());
    this.pending = null;
    this.queueChange();
  }

  replaceLocalTrack(track: MediaStreamTrack): Promise<void> {
    if (this.closed) return Promise.resolve();
    return Promise.all([this.active.replaceTrack(track), this.pending?.replaceTrack(track)]).then(
      () => undefined,
    );
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
    if (this.closed) return;
    this.active.setIceServers(iceServers);
    this.pending?.setIceServers(iceServers);
  }

  /** After a socket reconnect or a network change: media keeps flowing; repair if needed. */
  recover(): void {
    if (this.closed) return;
    this.active.recover();
    this.pending?.recover();
  }

  /** Tile sizes (Part 12 grid): Janus forwards a high or low simulcast layer per participant. */
  setVideoQuality(participantId: string, level: 'high' | 'low'): void {
    this.quality.set(participantId, level);
    this.active.setVideoQuality?.(participantId, level);
    this.pending?.setVideoQuality?.(participantId, level);
  }

  /** Idempotent; returns the summaries of the connections closed by this call. */
  close(): PeerSummary[] {
    if (this.closed) return [];
    this.closed = true;
    const summaries = this.pending?.close() ?? [];
    this.pending = null;
    return [...summaries, ...this.active.close()];
  }

  private createSfu(join: SfuJoin, { activeFromStart }: { activeFromStart: boolean }): SfuLike {
    const options: SfuTransportOptions = {
      sessionId: this.opts.sessionId,
      selfParticipantId: this.opts.selfParticipantId,
      join,
      localStream: this.opts.localStream,
      iceServers: this.iceServers,
      forceRelay: this.opts.forceRelay,
      refreshToken: () => this.opts.refreshSfuToken?.(join.epoch) ?? Promise.resolve(null),
      onChange: () => {
        this.queueChange();
      },
      onReady: () => {
        if (!activeFromStart) this.promote(transport);
      },
      onFailed: () => {
        if (!this.closed && this.active === transport) this.opts.onFailed(null);
      },
      ...(this.opts.onError === undefined ? {} : { onError: this.opts.onError }),
    };
    const transport: SfuLike = (this.opts.createSfuTransport ?? ((o) => new SfuTransport(o)))(
      options,
    );
    for (const [participantId, level] of this.quality) {
      transport.setVideoQuality?.(participantId, level);
    }
    return transport;
  }

  /** The pending Janus transport carries everyone: swap, close the old media, confirm. */
  private promote(transport: SfuLike): void {
    if (this.closed || this.pending !== transport) return;
    const previous = this.active;
    this.active = transport;
    this.pending = null;
    this.reportSummaries(previous.close());
    this.queueChange();
    this.opts.onTopologyReady?.(transport.epoch);
  }

  private reportSummaries(summaries: PeerSummary[]): void {
    if (summaries.length > 0) this.opts.onSummaries?.(summaries);
  }

  private queueChange(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      if (!this.closed) this.opts.onChange(this.view());
    });
  }
}
