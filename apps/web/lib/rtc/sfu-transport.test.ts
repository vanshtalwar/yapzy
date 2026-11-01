import { type PeerRole, type SfuJoin } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import { CallManager } from './call-manager.ts';
import { type JanusClient, type Jsep } from './janus-client.ts';
import { SfuTransport, type SfuTransportOptions } from './sfu-transport.ts';
import { FakeMediaStream, FakePeerConnection, FakeTrack, flush } from './testing.ts';
import { type CallTransport, type CallView, type PeerSummary } from './types.ts';

const SESSION = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const SELF = 'pSelf0000001';
const ALICE = 'pAlice000001';
const BOB = 'pBob00000001';
const JOIN: SfuJoin = {
  wsUrl: 'ws://janus.test:8188',
  roomId: 1234,
  token: `${String(Math.floor(Date.now() / 1000) + 600)},janus,janus.plugin.videoroom,n=x:sig`,
  epoch: 1,
};

interface Request {
  handle: number;
  body: Record<string, unknown>;
  jsep?: Jsep;
}
interface Events {
  onEvent?: (data: Record<string, unknown>, jsep: Jsep | undefined) => void;
}

/**
 * Scripted stand-in for JanusClient: answers VideoRoom requests like Janus (joined, publish
 * answer, attached/updated offers) and lets tests push events to a handle.
 */
class FakeJanus {
  readonly requests: Request[] = [];
  readonly handles = new Map<number, Events>();
  publishers: { id: number; display: string }[] = [];
  connected = true;
  destroyed = false;
  claims = 0;
  onClose: (() => void) | null = null;
  onSessionLost: (() => void) | null = null;
  private nextHandle = 100;

  readonly session = 1;
  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  createSession(): Promise<number> {
    return Promise.resolve(1);
  }
  claim(): Promise<boolean> {
    this.claims += 1;
    return Promise.resolve(true);
  }
  attach(_plugin: string, events: Events) {
    this.nextHandle += 1;
    const id = this.nextHandle;
    this.handles.set(id, events);
    return Promise.resolve({
      id,
      message: (body: Record<string, unknown>, jsep?: Jsep) => this.message(id, body, jsep),
      trickle: () => undefined,
      detach: () => undefined,
    });
  }
  dropConnection(): void {
    this.connected = false;
  }
  destroy(): void {
    this.destroyed = true;
  }
  trickle(): void {
    // ICE candidates are not simulated
  }

  /** Streams of a subscription to `feeds`: audio + video m-lines per feed. */
  streamsFor(feeds: number[]) {
    return feeds.flatMap((feed, index) => {
      const display = this.publishers.find((p) => p.id === feed)?.display ?? '';
      return [
        { mid: String(index * 2), type: 'audio', feed_id: feed, feed_display: display },
        { mid: String(index * 2 + 1), type: 'video', feed_id: feed, feed_display: display },
      ];
    });
  }

  subscribedFeeds: number[] = [];

  private message(handle: number, body: Record<string, unknown>, jsep?: Jsep) {
    this.requests.push({ handle, body, ...(jsep === undefined ? {} : { jsep }) });
    const feedsOf = (value: unknown) => (value as { feed: number }[]).map((stream) => stream.feed);
    switch (body.request) {
      case 'join':
        if (body.ptype === 'publisher') {
          return Promise.resolve({
            data: { videoroom: 'joined', id: 7, private_id: 77, publishers: this.publishers },
          });
        }
        this.subscribedFeeds = feedsOf(body.streams);
        return Promise.resolve({
          data: { videoroom: 'attached', streams: this.streamsFor(this.subscribedFeeds) },
          jsep: { type: 'offer' as const, sdp: 'janus-offer-1' },
        });
      case 'publish':
        return Promise.resolve({
          data: { videoroom: 'event', configured: 'ok' },
          jsep: { type: 'answer' as const, sdp: 'janus-answer' },
        });
      case 'subscribe':
      case 'unsubscribe': {
        const change = feedsOf(body.streams);
        this.subscribedFeeds =
          body.request === 'subscribe'
            ? [...this.subscribedFeeds, ...change]
            : this.subscribedFeeds.filter((feed) => !change.includes(feed));
        return Promise.resolve({
          data: { videoroom: 'updated', streams: this.streamsFor(this.subscribedFeeds) },
          jsep: { type: 'offer' as const, sdp: `janus-offer-${String(this.requests.length)}` },
        });
      }
      default:
        return Promise.resolve({ data: { videoroom: 'event', result: 'ok' } });
    }
  }

  requestsOf(name: string): Request[] {
    return this.requests.filter((request) => request.body.request === name);
  }

  /** An unsolicited plugin event on the publisher handle (new publishers, talking, …). */
  publisherEvent(data: Record<string, unknown>): void {
    const [first] = this.handles.values();
    first?.onEvent?.(data, undefined);
  }
}

const role = (participantId: string): PeerRole => ({
  participantId,
  initiator: false,
  polite: true,
});

function setup(overrides: Partial<SfuTransportOptions> = {}) {
  const janus = new FakeJanus();
  const pcs: FakePeerConnection[] = [];
  const localTracks = [new FakeTrack('audio'), new FakeTrack('video')];
  const onReady = vi.fn();
  const onChange = vi.fn();
  const transport = new SfuTransport({
    sessionId: SESSION,
    selfParticipantId: SELF,
    join: JOIN,
    localStream: new FakeMediaStream(localTracks) as unknown as MediaStream,
    iceServers: [],
    forceRelay: false,
    refreshToken: () => Promise.resolve('fresh-token'),
    onChange,
    onReady,
    onFailed: vi.fn(),
    createClient: () => janus as unknown as JanusClient,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createMediaStream: () => new FakeMediaStream() as unknown as MediaStream,
    statsIntervalMs: 60_000,
    ...overrides,
  });
  return { transport, janus, pcs, localTracks, onReady, onChange };
}

describe('SfuTransport', () => {
  it('joins as publisher (display = own participantId, own token) and publishes simulcast', async () => {
    const { janus, pcs, transport } = setup();
    await flush(30);
    const [join] = janus.requestsOf('join');
    expect(join?.body).toEqual({
      request: 'join',
      ptype: 'publisher',
      room: JOIN.roomId,
      display: SELF,
      token: JOIN.token,
    });
    const publisher = pcs[0];
    expect(publisher?.transceivers.map((t) => [t.sender.track?.kind, t.direction])).toEqual([
      ['audio', 'sendonly'],
      ['video', 'sendonly'],
    ]);
    expect(publisher?.transceivers[1]?.sendEncodings.map((e) => e.rid)).toEqual(['h', 'm', 'l']);
    expect(janus.requestsOf('publish')[0]?.jsep?.type).toBe('offer');
    expect(publisher?.remoteDescription).toEqual({ type: 'answer', sdp: 'janus-answer' });
    transport.close();
  });

  it('subscribes only to feeds of session participants and maps tracks by mid', async () => {
    const { janus, pcs, transport } = setup();
    janus.publishers = [
      { id: 11, display: ALICE },
      { id: 99, display: 'pStranger0001' }, // not in this session: ignored
    ];
    transport.addPeer(role(ALICE));
    await flush(40);
    const subscriberJoin = janus.requestsOf('join')[1];
    expect(subscriberJoin?.body).toMatchObject({
      ptype: 'subscriber',
      private_id: 77,
      streams: [{ feed: 11 }],
      token: JOIN.token,
    });
    const subscriber = pcs[1];
    expect(subscriber?.remoteDescription).toEqual({ type: 'offer', sdp: 'janus-offer-1' });
    expect(janus.requestsOf('start')[0]?.jsep?.type).toBe('answer');
    const video = subscriber?.fireRemoteTrack('1', 'video');
    subscriber?.fireRemoteTrack('5', 'video'); // unknown mid: dropped
    expect(transport.remoteStream(ALICE)?.getTracks()).toEqual([video]);
    expect(transport.participants()).toEqual([
      expect.objectContaining({ participantId: ALICE, trackCount: 1 }),
    ]);
    transport.close();
  });

  it('is ready only when the subscriber is connected and every participant’s video flows', async () => {
    const { janus, pcs, transport, onReady } = setup();
    janus.publishers = [
      { id: 11, display: ALICE },
      { id: 12, display: BOB },
    ];
    transport.addPeer(role(ALICE));
    transport.addPeer(role(BOB));
    await flush(40);
    const subscriber = pcs[1];
    const aliceVideo = subscriber?.fireRemoteTrack('1', 'video');
    const bobVideo = subscriber?.fireRemoteTrack('3', 'video');
    pcs[0]?.setConnectionState('connected');
    subscriber?.setConnectionState('connected');
    aliceVideo?.unmute();
    expect(onReady).not.toHaveBeenCalled(); // Bob's media hasn't arrived yet
    bobVideo?.unmute();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(transport.isReady).toBe(true);
    transport.close();
  });

  it('subscribes to a participant who publishes later and unsubscribes when they leave', async () => {
    const { janus, transport } = setup();
    janus.publishers = [{ id: 11, display: ALICE }];
    transport.addPeer(role(ALICE));
    await flush(40);
    janus.publishers.push({ id: 12, display: BOB });
    transport.addPeer(role(BOB));
    janus.publisherEvent({ videoroom: 'event', publishers: [{ id: 12, display: BOB }] });
    await flush(40);
    expect(janus.requestsOf('subscribe')[0]?.body.streams).toEqual([{ feed: 12 }]);
    transport.removePeer(BOB);
    await flush(40);
    expect(janus.requestsOf('unsubscribe')[0]?.body.streams).toEqual([{ feed: 12 }]);
    transport.close();
  });

  it('marks the active speaker from Janus talking events and picks simulcast layers', async () => {
    const { janus, transport } = setup();
    janus.publishers = [{ id: 11, display: ALICE }];
    transport.addPeer(role(ALICE));
    await flush(40);
    janus.publisherEvent({ videoroom: 'talking', id: 11 });
    expect(transport.participants()[0]?.speaking).toBe(true);
    janus.publisherEvent({ videoroom: 'stopped-talking', id: 11 });
    expect(transport.participants()[0]?.speaking).toBe(false);
    transport.close();
  });

  it('claims its Janus session again after the WebSocket dropped (media untouched)', async () => {
    const { janus, pcs, transport } = setup();
    await flush(30);
    janus.onClose?.();
    await flush(30);
    expect(janus.claims).toBe(1);
    expect(pcs).toHaveLength(1); // no new publisher connection: the session was kept
    expect(pcs[0]?.closeCalls).toBe(0);
    transport.close();
  });

  it('close() ends the Janus session and returns one summary per participant', async () => {
    const { janus, pcs, transport } = setup();
    janus.publishers = [{ id: 11, display: ALICE }];
    transport.addPeer(role(ALICE));
    await flush(40);
    const summaries = transport.close();
    expect(summaries.map((summary) => summary.peer)).toEqual([ALICE]);
    expect(janus.destroyed).toBe(true);
    expect(pcs.every((pc) => pc.closeCalls === 1)).toBe(true);
    expect(transport.close()).toEqual([]); // idempotent
  });
});

/** A transport the test switches by hand (make-before-break order). */
class ManualTransport implements CallTransport {
  readonly topology: 'mesh' | 'sfu';
  readonly epoch: number;
  readonly peers: string[] = [];
  closed = false;
  options: SfuTransportOptions | null = null;
  readonly stream = new FakeMediaStream() as unknown as MediaStream;

  constructor(topology: 'mesh' | 'sfu', epoch = 0) {
    this.topology = topology;
    this.epoch = epoch;
  }
  addPeer(peer: PeerRole): void {
    this.peers.push(peer.participantId);
  }
  removePeer(): PeerSummary | null {
    return null;
  }
  handleSignal(): void {
    // not used
  }
  remoteStream(): MediaStream | null {
    return this.closed ? null : this.stream;
  }
  participants() {
    return this.peers.map((participantId) => ({
      participantId,
      state: 'connected' as const,
      quality: null,
      trackCount: 2,
    }));
  }
  replaceTrack(): Promise<void> {
    return Promise.resolve();
  }
  setIceServers(): void {
    // not used
  }
  recover(): void {
    // not used
  }
  close(): PeerSummary[] {
    if (this.closed) return [];
    this.closed = true;
    return this.peers.map((peer) => ({
      peer,
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      avgRttMs: null,
      avgBitrateKbps: null,
      timeToConnectedMs: null,
      failed: false,
    }));
  }
}

function manager(options: { sfu?: SfuJoin } = {}) {
  const mesh = new ManualTransport('mesh');
  const sfus: ManualTransport[] = [];
  const ready = vi.fn();
  const summaries = vi.fn();
  const views: CallView[] = [];
  const call = new CallManager({
    sessionId: SESSION,
    selfParticipantId: SELF,
    peers: [role(ALICE)],
    ...(options.sfu === undefined ? {} : { sfu: options.sfu }),
    localStream: new FakeMediaStream() as unknown as MediaStream,
    iceServers: [],
    forceRelay: false,
    signaling: { description: () => undefined, candidate: () => undefined },
    onChange: (view) => views.push(view),
    onFailed: vi.fn(),
    onTopologyReady: ready,
    onSummaries: summaries,
    createTransport: () => mesh,
    createSfuTransport: (sfuOptions) => {
      const transport = new ManualTransport('sfu', sfuOptions.join.epoch);
      transport.options = sfuOptions;
      sfus.push(transport);
      return transport;
    },
  });
  return { call, mesh, sfus, ready, summaries, views };
}

describe('CallManager make-before-break', () => {
  it('keeps P2P until Janus carries everyone, then swaps, closes P2P and confirms', async () => {
    const { call, mesh, sfus, ready, summaries } = manager();
    call.switchToSfu({ ...JOIN, epoch: 1 });
    await flush();
    const sfu = sfus[0];
    expect(sfu?.peers).toEqual([ALICE]);
    expect(call.view()).toMatchObject({ topology: 'mesh', switching: true });
    expect(call.remoteStream(ALICE)).toBe(mesh.stream); // still the P2P media
    expect(mesh.closed).toBe(false);

    sfu?.options?.onReady(); // every participant's media arrived through Janus
    expect(call.view()).toMatchObject({ topology: 'sfu', switching: false });
    expect(call.remoteStream(ALICE)).toBe(sfu?.stream);
    expect(mesh.closed).toBe(true);
    expect(summaries).toHaveBeenCalledWith([expect.objectContaining({ peer: ALICE })]);
    expect(ready).toHaveBeenCalledWith(1);
    call.switchToSfu({ ...JOIN, epoch: 1 }); // duplicate announcement: ignored
    expect(sfus).toHaveLength(1);
  });

  it('rolls back: closes the Janus side, P2P keeps running', () => {
    const { call, mesh, sfus, ready } = manager();
    call.switchToSfu({ ...JOIN, epoch: 1 });
    call.rollback(1);
    expect(sfus[0]?.closed).toBe(true);
    expect(mesh.closed).toBe(false);
    expect(call.view()).toMatchObject({ topology: 'mesh', switching: false });
    expect(ready).not.toHaveBeenCalled();
  });

  it('moves to a new Janus room on failover (epoch + 1) the same way', () => {
    const { call, sfus, ready } = manager({ sfu: JOIN });
    const first = sfus[0];
    expect(call.view().topology).toBe('sfu');
    call.switchToSfu({ ...JOIN, roomId: 99, epoch: 2 });
    expect(first?.closed).toBe(false); // old room keeps playing (if it still can)
    sfus[1]?.options?.onReady();
    expect(first?.closed).toBe(true);
    expect(ready).toHaveBeenCalledWith(2);
    call.switchToSfu({ ...JOIN, epoch: 1 }); // older epoch: ignored
    expect(sfus).toHaveLength(2);
  });
});
