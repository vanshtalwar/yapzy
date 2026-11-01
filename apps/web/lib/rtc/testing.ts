// Test doubles for the WebRTC layer (jsdom has no WebRTC). Only what our code uses.

let trackCounter = 0;

export class FakeTrack {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  enabled = true;
  stopped = false;
  contentHint = '';
  /** Remote tracks start muted and unmute when media arrives (SFU readiness). */
  muted = false;
  onended: (() => void) | null = null;
  private readonly deviceId: string;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(kind: 'audio' | 'video', deviceId = `${kind}-default`) {
    trackCounter += 1;
    this.kind = kind;
    this.deviceId = deviceId;
    this.id = `${kind}-${String(trackCounter)}`;
  }

  stop(): void {
    this.stopped = true;
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Test helper: media started flowing on this remote track. */
  unmute(): void {
    this.muted = false;
    for (const listener of this.listeners.get('unmute') ?? []) listener();
  }
}

/** Minimal RTCRtpTransceiver: a mid, a sender (local track) and a receiver (remote track). */
export class FakeTransceiver {
  mid: string | null;
  readonly direction: RTCRtpTransceiverDirection;
  readonly sender: FakeSender;
  readonly receiver: { track: FakeTrack };
  readonly sendEncodings: RTCRtpEncodingParameters[];

  constructor(options: {
    mid: string | null;
    direction: RTCRtpTransceiverDirection;
    sendTrack?: FakeTrack | null;
    receiveTrack: FakeTrack;
    sendEncodings?: RTCRtpEncodingParameters[];
  }) {
    this.mid = options.mid;
    this.direction = options.direction;
    this.sender = new FakeSender(options.sendTrack ?? null);
    this.receiver = { track: options.receiveTrack };
    this.sendEncodings = options.sendEncodings ?? [];
  }
}

export class FakeMediaStream {
  private readonly tracks = new Set<FakeTrack>();

  constructor(tracks: FakeTrack[] = []) {
    for (const track of tracks) this.tracks.add(track);
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.getTracks().filter((track) => track.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.getTracks().filter((track) => track.kind === 'video');
  }
  addTrack(track: FakeTrack): void {
    this.tracks.add(track);
  }
  removeTrack(track: FakeTrack): void {
    this.tracks.delete(track);
  }
}

export class FakeSender {
  parameters: RTCRtpSendParameters = {
    encodings: [{}],
    transactionId: 't1',
    codecs: [],
    headerExtensions: [],
    rtcp: {},
  };
  rejectDegradationPreference = false;
  track: FakeTrack | null;

  constructor(track: FakeTrack | null) {
    this.track = track;
  }

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }
  setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    if (this.rejectDegradationPreference && parameters.degradationPreference !== undefined) {
      return Promise.reject(new DOMException('unsupported', 'InvalidModificationError'));
    }
    this.parameters = parameters;
    return Promise.resolve();
  }
  replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track;
    return Promise.resolve();
  }
}

type Handler<E> = ((event: E) => void) | null;

/**
 * Signaling-state machine of RTCPeerConnection (incl. implicit rollback) without media.
 * `log` records the order of operations; tests drive events with the `fire*` helpers.
 */
export class FakePeerConnection {
  configuration: RTCConfiguration;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly senders: FakeSender[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly log: string[] = [];
  /** Were all four handlers set when the first track/remote description was applied? */
  handlersReadyAtFirstUse: boolean | null = null;
  closeCalls = 0;
  restartIceCalls = 0;
  stats = new Map<string, Record<string, unknown>>();

  ontrack: Handler<RTCTrackEvent> = null;
  onicecandidate: Handler<RTCPeerConnectionIceEvent> = null;
  onnegotiationneeded: Handler<Event> = null;
  onconnectionstatechange: Handler<Event> = null;

  private sdpCounter = 0;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  private firstUse(operation: string): void {
    this.log.push(operation);
    this.handlersReadyAtFirstUse ??=
      this.ontrack !== null &&
      this.onicecandidate !== null &&
      this.onnegotiationneeded !== null &&
      this.onconnectionstatechange !== null;
  }

  addTrack(track: FakeTrack): FakeSender {
    this.firstUse(`addTrack:${track.kind}`);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }

  getSenders(): FakeSender[] {
    return this.senders;
  }

  addTransceiver(
    track: FakeTrack,
    init: {
      direction?: RTCRtpTransceiverDirection;
      sendEncodings?: RTCRtpEncodingParameters[];
    } = {},
  ): FakeTransceiver {
    this.log.push(`addTransceiver:${track.kind}`);
    const transceiver = new FakeTransceiver({
      mid: String(this.transceivers.length),
      direction: init.direction ?? 'sendrecv',
      sendTrack: track,
      receiveTrack: new FakeTrack(track.kind),
      ...(init.sendEncodings === undefined ? {} : { sendEncodings: init.sendEncodings }),
    });
    this.transceivers.push(transceiver);
    this.senders.push(transceiver.sender);
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers;
  }

  setLocalDescription(): Promise<void> {
    this.log.push('setLocalDescription');
    this.sdpCounter += 1;
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: `answer-${String(this.sdpCounter)}` };
      this.signalingState = 'stable';
    } else {
      this.localDescription = { type: 'offer', sdp: `offer-${String(this.sdpCounter)}` };
      this.signalingState = 'have-local-offer';
    }
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.firstUse(`setRemoteDescription:${description.type}`);
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        this.log.push('rollback'); // implicit rollback (polite peer in a collision)
        this.localDescription = null;
      }
      this.signalingState = 'have-remote-offer';
    } else if (this.signalingState === 'have-local-offer') {
      this.signalingState = 'stable';
    } else {
      return Promise.reject(new DOMException('no offer pending', 'InvalidStateError'));
    }
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.remoteDescription === null) {
      return Promise.reject(new DOMException('no remote description', 'InvalidStateError'));
    }
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }

  restartIce(): void {
    this.restartIceCalls += 1;
  }

  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
  }

  getStats(): Promise<Map<string, Record<string, unknown>>> {
    return Promise.resolve(this.stats);
  }

  close(): void {
    this.closeCalls += 1;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }

  // --- test helpers ---
  fireNegotiationNeeded(): void {
    this.onnegotiationneeded?.(new Event('negotiationneeded'));
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }

  fireTrack(track: FakeTrack): void {
    this.ontrack?.({ track } as unknown as RTCTrackEvent);
  }

  /** A remote (muted) track on m-line `mid`, as a subscriber receives it from Janus. */
  fireRemoteTrack(mid: string, kind: 'audio' | 'video'): FakeTrack {
    const track = new FakeTrack(kind);
    track.muted = true;
    const transceiver = new FakeTransceiver({ mid, direction: 'recvonly', receiveTrack: track });
    this.transceivers.push(transceiver);
    this.ontrack?.({ track, transceiver } as unknown as RTCTrackEvent);
    return track;
  }

  fireCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({
      candidate: candidate === null ? null : { toJSON: () => candidate },
    } as unknown as RTCPeerConnectionIceEvent);
  }
}

/** Runs queued promise callbacks (signals are processed on a promise chain). */
export async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}
