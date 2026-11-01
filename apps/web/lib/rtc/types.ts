import { type PeerRole, type RtcSummaryPayload } from '@app/shared';

export type PeerState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';
export type Quality = 'good' | 'fair' | 'poor';

/** Plain view of one remote participant for React — never media objects (D-049). */
export interface RemoteParticipantView {
  participantId: string;
  state: PeerState;
  quality: Quality | null;
  /** Number of remote tracks received so far; a change means "re-attach the <video>". */
  trackCount: number;
  /** Janus audio-level events say this participant is talking (SFU calls only). */
  speaking?: boolean;
}

export interface CallView {
  sessionId: string;
  topology: 'mesh' | 'sfu';
  participants: RemoteParticipantView[];
  /** A switch to Janus (or to a new Janus room) is in progress behind the current media. */
  switching: boolean;
  /**
   * 0 while P2P, else the epoch of the Janus room in use. It changes whenever the media path
   * changes (switch, failover): the UI re-attaches every `<video>` to the new streams.
   */
  epoch: number;
}

/** An incoming WebRTC signal for this client (validated by the socket contract). */
export type RtcSignal =
  | { kind: 'offer' | 'answer'; sessionId: string; from: string; sdp: string }
  | { kind: 'ice'; sessionId: string; from: string; candidate: RTCIceCandidateInit };

/** Outgoing signaling; the CallManager's owner binds it to the session. */
export interface CallSignaling {
  description(to: string, type: 'offer' | 'answer', sdp: string): void;
  candidate(to: string, candidate: RTCIceCandidateInit): void;
}

/** `rtc:summary` payload without the session id (added when it is sent). */
export type PeerSummary = Omit<RtcSummaryPayload, 'sessionId'>;

/**
 * How media reaches the other participants. `MeshTransport` (Part 7): one RTCPeerConnection
 * per remote participant. `SfuTransport` (Part 11): one publisher + one subscriber connection
 * to Janus. The CallManager runs both while it switches make-before-break, which is why the UI
 * only ever asks the CallManager for participants and streams.
 */
export interface CallTransport {
  readonly topology: 'mesh' | 'sfu';
  addPeer(peer: PeerRole): void;
  /** Tears down one participant's media; returns its summary if it existed. */
  removePeer(participantId: string): PeerSummary | null;
  handleSignal(signal: RtcSignal): void;
  remoteStream(participantId: string): MediaStream | null;
  participants(): RemoteParticipantView[];
  /** A local device changed: send the new track everywhere (no renegotiation). */
  replaceTrack(track: MediaStreamTrack): Promise<void>;
  /** Fresh TURN credentials (relayed connections re-allocate with them). */
  setIceServers(iceServers: RTCIceServer[]): void;
  /** The network or the signaling connection changed: recover what isn't connected. */
  recover(): void;
  /** SFU only: receive a participant's high (large tile) or low (small tile) video layer. */
  setVideoQuality?(participantId: string, level: 'high' | 'low'): void;
  /** Closes everything; one summary per peer connection that was still open. */
  close(): PeerSummary[];
}
