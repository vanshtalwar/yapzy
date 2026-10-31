import { type PeerRole } from '@app/shared';

import { PeerSession, type PeerSessionOptions } from './peer-session.ts';
import {
  type CallSignaling,
  type CallTransport,
  type PeerSummary,
  type RemoteParticipantView,
  type RtcSignal,
} from './types.ts';

export interface MeshTransportOptions {
  sessionId: string;
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  signaling: CallSignaling;
  onChange: () => void;
  onFailed: (participantId: string) => void;
  onError?: (message: string, error: unknown) => void;
  /** Tests inject fakes (RTCPeerConnection, MediaStream, timers). */
  peerDefaults?: Partial<PeerSessionOptions>;
}

/** Direct P2P: one PeerSession per remote participant, signals routed by `from`. */
export class MeshTransport implements CallTransport {
  readonly topology = 'mesh' as const;
  private readonly opts: MeshTransportOptions;
  private readonly peers = new Map<string, PeerSession>();
  private iceServers: RTCIceServer[];

  constructor(opts: MeshTransportOptions) {
    this.opts = opts;
    this.iceServers = opts.iceServers;
  }

  addPeer(peer: PeerRole): void {
    if (this.peers.has(peer.participantId)) return;
    const { participantId } = peer;
    const session = new PeerSession({
      ...this.opts.peerDefaults,
      sessionId: this.opts.sessionId,
      peer,
      localStream: this.opts.localStream,
      iceServers: this.iceServers,
      forceRelay: this.opts.forceRelay,
      signaling: {
        description: (type, sdp) => {
          this.opts.signaling.description(participantId, type, sdp);
        },
        candidate: (candidate) => {
          this.opts.signaling.candidate(participantId, candidate);
        },
      },
      onChange: this.opts.onChange,
      onFailed: () => {
        this.opts.onFailed(participantId);
      },
      ...(this.opts.onError === undefined ? {} : { onError: this.opts.onError }),
    });
    this.peers.set(participantId, session);
    this.opts.onChange();
  }

  removePeer(participantId: string): PeerSummary | null {
    const session = this.peers.get(participantId);
    if (session === undefined) return null;
    this.peers.delete(participantId);
    const summary = session.close();
    this.opts.onChange();
    return summary;
  }

  handleSignal(signal: RtcSignal): void {
    void this.peers.get(signal.from)?.handleSignal(signal);
  }

  remoteStream(participantId: string): MediaStream | null {
    return this.peers.get(participantId)?.remoteStream ?? null;
  }

  participants(): RemoteParticipantView[] {
    return [...this.peers.values()].map((session) => session.view());
  }

  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    await Promise.all([...this.peers.values()].map((session) => session.replaceTrack(track)));
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
    for (const session of this.peers.values()) session.setIceServers(iceServers);
  }

  recover(): void {
    for (const session of this.peers.values()) session.recover();
  }

  close(): PeerSummary[] {
    const summaries = [...this.peers.values()].map((session) => session.close());
    this.peers.clear();
    return summaries;
  }
}
