import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PeerSession, type PeerSessionOptions } from './peer-session.ts';
import { FakeMediaStream, FakePeerConnection, FakeTrack, flush } from './testing.ts';
import { type RtcSignal } from './types.ts';

const SESSION = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_SESSION = '0199a3b2-7c4d-7e5f-8a9b-000000000000';

interface Sent {
  type: 'offer' | 'answer' | 'ice';
  value: unknown;
}

function setup(initiator: boolean, overrides: Partial<PeerSessionOptions> = {}) {
  const pcs: FakePeerConnection[] = [];
  const sent: Sent[] = [];
  const localTracks = [new FakeTrack('audio'), new FakeTrack('video')];
  const local = new FakeMediaStream(localTracks);
  const onChange = vi.fn();
  const onFailed = vi.fn();
  const remoteId = initiator ? 'pPolite00001' : 'pImpolite001';
  const session = new PeerSession({
    sessionId: SESSION,
    peer: { participantId: remoteId, initiator, polite: !initiator },
    localStream: local as unknown as MediaStream,
    iceServers: [{ urls: ['stun:localhost:3478'] }],
    forceRelay: false,
    signaling: {
      description: (type, sdp) => sent.push({ type, value: sdp }),
      candidate: (candidate) => sent.push({ type: 'ice', value: candidate }),
    },
    onChange,
    onFailed,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createMediaStream: () => new FakeMediaStream() as unknown as MediaStream,
    statsIntervalMs: 60_000,
    ...overrides,
  });
  const pc = pcs[0]!;
  const signal = (kind: 'offer' | 'answer', sdp: string, from = remoteId): Promise<void> =>
    session.handleSignal({ kind, sessionId: SESSION, from, sdp });
  const ice = (candidate: string, sessionId = SESSION): Promise<void> =>
    session.handleSignal({ kind: 'ice', sessionId, from: remoteId, candidate: { candidate } });
  return { session, pc, sent, local, localTracks, onChange, onFailed, signal, ice, remoteId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PeerSession setup', () => {
  it('attaches every handler before adding tracks or applying a remote description', async () => {
    const polite = setup(false);
    expect(polite.pc.handlersReadyAtFirstUse).toBe(true);
    expect(polite.pc.log.slice(0, 2)).toEqual(['addTrack:audio', 'addTrack:video']);
    await polite.signal('offer', 'offer-from-initiator');
    expect(polite.pc.log).toContain('setRemoteDescription:offer');
    expect(polite.pc.handlersReadyAtFirstUse).toBe(true);
  });

  it('uses relay-only ICE when forced, all candidates otherwise', () => {
    expect(setup(true).pc.configuration.iceTransportPolicy).toBe('all');
    expect(setup(true, { forceRelay: true }).pc.configuration.iceTransportPolicy).toBe('relay');
  });

  it('puts remote tracks into its own stream and reports them', () => {
    const { pc, session, onChange } = setup(true);
    const remoteVideo = new FakeTrack('video');
    pc.fireTrack(remoteVideo);
    expect(session.remoteStream.getTracks()).toEqual([remoteVideo]);
    expect(session.view()).toMatchObject({ state: 'new', trackCount: 1 });
    expect(onChange).toHaveBeenCalled();
  });

  it('sends its ICE candidates but not the end-of-candidates marker', () => {
    const { pc, sent } = setup(true);
    pc.fireCandidate({ candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0' });
    pc.fireCandidate(null);
    expect(sent).toEqual([
      { type: 'ice', value: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0' } },
    ]);
  });
});

describe('perfect negotiation', () => {
  it('lets the initiator make the first offer while the polite side waits for it', async () => {
    const initiator = setup(true);
    initiator.pc.fireNegotiationNeeded();
    await flush();
    expect(initiator.sent).toEqual([{ type: 'offer', value: 'offer-1' }]);

    const polite = setup(false);
    polite.pc.fireNegotiationNeeded(); // its tracks were added — but it must not offer first
    await flush();
    expect(polite.sent).toEqual([]);

    await polite.signal('offer', 'offer-1');
    expect(polite.sent).toEqual([{ type: 'answer', value: 'answer-1' }]);
    expect(polite.pc.signalingState).toBe('stable');
  });

  it('resolves glare: the impolite offer wins, the polite side rolls back and answers', async () => {
    const impolite = setup(true);
    const polite = setup(false);
    // First negotiation.
    impolite.pc.fireNegotiationNeeded();
    await flush();
    await polite.signal('offer', 'offer-1');
    await impolite.signal('answer', 'answer-1');
    impolite.sent.length = 0;
    polite.sent.length = 0;

    // Both renegotiate at the same time (e.g. both restart ICE).
    impolite.pc.fireNegotiationNeeded();
    polite.pc.fireNegotiationNeeded();
    await flush();
    expect(impolite.pc.signalingState).toBe('have-local-offer');
    expect(polite.pc.signalingState).toBe('have-local-offer');
    const impoliteOffer = impolite.sent.find((s) => s.type === 'offer')!.value as string;
    const politeOffer = polite.sent.find((s) => s.type === 'offer')!.value as string;

    // The impolite peer ignores the colliding offer...
    await impolite.signal('offer', politeOffer);
    expect(impolite.pc.log.filter((entry) => entry === 'setRemoteDescription:offer')).toEqual([]);
    expect(impolite.sent.filter((s) => s.type === 'answer')).toEqual([]);
    // ...and its candidates for that offer fail silently.
    await impolite.ice('candidate:for-ignored-offer');

    // The polite peer rolls back its own offer and answers the impolite one.
    await polite.signal('offer', impoliteOffer);
    expect(polite.pc.log).toContain('rollback');
    const answer = polite.sent.find((s) => s.type === 'answer')!.value as string;
    await impolite.signal('answer', answer);
    expect(impolite.pc.signalingState).toBe('stable');
    expect(polite.pc.signalingState).toBe('stable');
  });

  it('queues remote candidates until the remote description exists, then adds them in order', async () => {
    const polite = setup(false);
    await polite.ice('candidate:a');
    await polite.ice('candidate:b');
    expect(polite.pc.addedCandidates).toEqual([]);
    await polite.signal('offer', 'offer-1');
    expect(polite.pc.addedCandidates).toEqual([
      { candidate: 'candidate:a' },
      { candidate: 'candidate:b' },
    ]);
    await polite.ice('candidate:c');
    expect(polite.pc.addedCandidates).toHaveLength(3);
  });

  it('drops signals of another session or another sender', async () => {
    const polite = setup(false);
    await polite.session.handleSignal({
      kind: 'offer',
      sessionId: OTHER_SESSION,
      from: polite.remoteId,
      sdp: 'stale',
    } satisfies RtcSignal);
    await polite.signal('offer', 'stranger', 'pSomeoneElse1');
    await polite.ice('candidate:stale', OTHER_SESSION);
    expect(polite.pc.log.some((entry) => entry.startsWith('setRemoteDescription'))).toBe(false);
    expect(polite.sent).toEqual([]);
  });
});

describe('connection monitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('restarts ICE after 3 s disconnected — initiator only, not if it recovers', async () => {
    const initiator = setup(true);
    const polite = setup(false);
    for (const { pc } of [initiator, polite]) {
      pc.setConnectionState('connected');
      pc.setConnectionState('disconnected');
    }
    await vi.advanceTimersByTimeAsync(2_999);
    expect(initiator.pc.restartIceCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(initiator.pc.restartIceCalls).toBe(1);
    expect(polite.pc.restartIceCalls).toBe(0);
    expect(initiator.session.view().state).toBe('reconnecting');

    const flaky = setup(true);
    flaky.pc.setConnectionState('connected');
    flaky.pc.setConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    flaky.pc.setConnectionState('connected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flaky.pc.restartIceCalls).toBe(0);
  });

  it('failed → one ICE restart, then gives up on the second failure', () => {
    const { pc, onFailed, session } = setup(true);
    pc.setConnectionState('connected');
    pc.setConnectionState('failed');
    expect(pc.restartIceCalls).toBe(1);
    expect(onFailed).not.toHaveBeenCalled();
    pc.setConnectionState('connecting');
    pc.setConnectionState('failed');
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(pc.restartIceCalls).toBe(1);
    expect(session.summary().failed).toBe(true);
  });

  it('gives up if the restarted connection is not back within 10 s', async () => {
    const polite = setup(false);
    polite.pc.setConnectionState('failed');
    expect(polite.pc.restartIceCalls).toBe(0); // waits for the initiator's restart offer
    await vi.advanceTimersByTimeAsync(9_999);
    expect(polite.onFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(polite.onFailed).toHaveBeenCalledTimes(1);
  });

  it('resets the restart budget once connected again', async () => {
    const { pc, onFailed } = setup(true);
    pc.setConnectionState('failed');
    pc.setConnectionState('connected');
    pc.setConnectionState('failed');
    expect(pc.restartIceCalls).toBe(2);
    expect(onFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('caps outgoing video at ~800 kbps, preferring frame rate', async () => {
    const { pc } = setup(true);
    pc.senders[1]!.rejectDegradationPreference = true; // e.g. a browser without support
    pc.setConnectionState('connected');
    await vi.advanceTimersByTimeAsync(0);
    const video = pc.senders.find((sender) => sender.track?.kind === 'video')!;
    expect(video.parameters.encodings[0]?.maxBitrate).toBe(800_000);
    const audio = pc.senders.find((sender) => sender.track?.kind === 'audio')!;
    expect(audio.parameters.encodings[0]?.maxBitrate).toBeUndefined();

    const supported = setup(true);
    supported.pc.setConnectionState('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(supported.pc.senders[1]!.parameters).toMatchObject({
      degradationPreference: 'maintain-framerate',
    });
  });
});

describe('closing', () => {
  it('is idempotent, detaches handlers, empties the remote stream and keeps local media', () => {
    const { session, pc, localTracks } = setup(true);
    pc.fireTrack(new FakeTrack('video'));
    pc.setConnectionState('connected');
    const first = session.close();
    const second = session.close();
    expect(second).toEqual(first);
    expect(pc.closeCalls).toBe(1);
    expect(pc.ontrack).toBeNull();
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onnegotiationneeded).toBeNull();
    expect(pc.onconnectionstatechange).toBeNull();
    expect(session.remoteStream.getTracks()).toEqual([]);
    expect(localTracks.every((track) => !track.stopped)).toBe(true);
    expect(session.view().state).toBe('closed');
  });

  it('ignores signals and state changes after close', async () => {
    const { session, pc, sent, onFailed, signal } = setup(false);
    session.close();
    await signal('offer', 'late');
    pc.setConnectionState('failed');
    expect(sent).toEqual([]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('a signaling reconnect never closes it; recover() restarts ICE only when needed', async () => {
    const { session, pc, signal } = setup(true);
    pc.fireNegotiationNeeded();
    await flush();
    await signal('answer', 'answer-1');
    pc.setConnectionState('connected');
    session.recover(); // after session:resume, with media still flowing
    expect(pc.restartIceCalls).toBe(0);
    pc.setConnectionState('disconnected');
    session.recover(); // after a network change
    expect(pc.restartIceCalls).toBe(1);
    expect(pc.closeCalls).toBe(0);
    session.close();
  });
});
