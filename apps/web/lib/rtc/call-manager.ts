import { type PeerRole } from '@app/shared';

import { MeshTransport, type MeshTransportOptions } from './mesh-transport.ts';
import {
  type CallSignaling,
  type CallTransport,
  type CallView,
  type PeerSummary,
  type RtcSignal,
} from './types.ts';

export interface CallManagerOptions {
  sessionId: string;
  peers: PeerRole[];
  /** Acquired once per tab and shared by every call; a call never stops it. */
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  signaling: CallSignaling;
  /** Plain snapshot for React, coalesced per microtask. */
  onChange: (view: CallView) => void;
  /** A participant's media could not be (re)established. */
  onFailed: (participantId: string) => void;
  onError?: (message: string, error: unknown) => void;
  createTransport?: (options: MeshTransportOptions) => CallTransport;
}

/**
 * One per chat session. Owns the media transport(s) and is the only thing the UI asks for
 * remote participants and their streams. Part 11 lets it hold a second (SFU) transport while
 * switching make-before-break; today it always has exactly one mesh transport.
 */
export class CallManager {
  readonly sessionId: string;
  private readonly transport: CallTransport;
  private readonly opts: CallManagerOptions;
  private closed = false;
  private changeQueued = false;

  constructor(opts: CallManagerOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    const create = opts.createTransport ?? ((options) => new MeshTransport(options));
    this.transport = create({
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
    for (const peer of opts.peers) this.transport.addPeer(peer);
  }

  /** Signals of another session (a call the user already left) are dropped. */
  handleSignal(signal: RtcSignal): void {
    if (this.closed || signal.sessionId !== this.sessionId) return;
    this.transport.handleSignal(signal);
  }

  removePeer(participantId: string): PeerSummary | null {
    return this.closed ? null : this.transport.removePeer(participantId);
  }

  remoteStream(participantId: string): MediaStream | null {
    return this.closed ? null : this.transport.remoteStream(participantId);
  }

  view(): CallView {
    return {
      sessionId: this.sessionId,
      topology: this.transport.topology,
      participants: this.closed ? [] : this.transport.participants(),
    };
  }

  replaceLocalTrack(track: MediaStreamTrack): Promise<void> {
    return this.closed ? Promise.resolve() : this.transport.replaceTrack(track);
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    if (!this.closed) this.transport.setIceServers(iceServers);
  }

  /** After a socket reconnect or a network change: media keeps flowing; repair if needed. */
  recover(): void {
    if (!this.closed) this.transport.recover();
  }

  /** Idempotent; returns the summaries of the connections closed by this call. */
  close(): PeerSummary[] {
    if (this.closed) return [];
    this.closed = true;
    return this.transport.close();
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
