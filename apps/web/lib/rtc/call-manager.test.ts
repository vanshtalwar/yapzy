import { type PeerRole } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import { CallManager } from './call-manager.ts';
import { MeshTransport } from './mesh-transport.ts';
import { FakeMediaStream, FakePeerConnection, FakeTrack, flush } from './testing.ts';
import { type CallView } from './types.ts';

const SESSION = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';

function setup(peers: PeerRole[]) {
  const pcs: FakePeerConnection[] = [];
  const localTracks = [new FakeTrack('audio'), new FakeTrack('video')];
  const localStream = new FakeMediaStream(localTracks);
  const views: CallView[] = [];
  const sent: { to: string; type: string }[] = [];
  const onFailed = vi.fn();
  const call = new CallManager({
    sessionId: SESSION,
    peers,
    localStream: localStream as unknown as MediaStream,
    iceServers: [],
    forceRelay: false,
    signaling: {
      description: (to, type) => sent.push({ to, type }),
      candidate: (to) => sent.push({ to, type: 'ice' }),
    },
    onChange: (view) => views.push(view),
    onFailed,
    createTransport: (options) =>
      new MeshTransport({
        ...options,
        peerDefaults: {
          createPeerConnection: (configuration) => {
            const pc = new FakePeerConnection(configuration);
            pcs.push(pc);
            return pc as unknown as RTCPeerConnection;
          },
          createMediaStream: () => new FakeMediaStream() as unknown as MediaStream,
          statsIntervalMs: 60_000,
        },
      }),
  });
  return { call, pcs, localTracks, views, sent, onFailed };
}

const peer = (participantId: string, initiator = false): PeerRole => ({
  participantId,
  initiator,
  polite: !initiator,
});

describe('CallManager (mesh)', () => {
  it('creates one connection per remote participant, all sharing the local tracks', () => {
    const { call, pcs, localTracks } = setup([peer('pAlpha000001'), peer('pBravo000001')]);
    expect(pcs).toHaveLength(2);
    for (const pc of pcs) {
      expect(pc.senders.map((sender) => sender.track)).toEqual(localTracks);
    }
    expect(call.view().participants.map((p) => p.participantId)).toEqual([
      'pAlpha000001',
      'pBravo000001',
    ]);
  });

  it('routes each signal to the connection of its sender', async () => {
    const { call, pcs, sent } = setup([peer('pAlpha000001'), peer('pBravo000001')]);
    call.handleSignal({ kind: 'offer', sessionId: SESSION, from: 'pBravo000001', sdp: 'offer-b' });
    await flush();
    expect(pcs[0]!.remoteDescription).toBeNull();
    expect(pcs[1]!.remoteDescription).toEqual({ type: 'offer', sdp: 'offer-b' });
    expect(sent).toEqual([{ to: 'pBravo000001', type: 'answer' }]);

    call.handleSignal({
      kind: 'ice',
      sessionId: SESSION,
      from: 'pAlpha000001',
      candidate: { candidate: 'c' },
    });
    call.handleSignal({ kind: 'offer', sessionId: SESSION, from: 'pUnknown0001', sdp: 'x' });
    await flush();
    expect(pcs[1]!.addedCandidates).toEqual([]);
  });

  it('drops signals of another session', async () => {
    const { call, pcs } = setup([peer('pAlpha000001')]);
    call.handleSignal({
      kind: 'offer',
      sessionId: '0199a3b2-7c4d-7e5f-8a9b-000000000000',
      from: 'pAlpha000001',
      sdp: 'stale',
    });
    await flush();
    expect(pcs[0]!.remoteDescription).toBeNull();
  });

  it('removes one participant (peer:left) and keeps the others and the local media', () => {
    const { call, pcs, localTracks } = setup([peer('pAlpha000001'), peer('pBravo000001')]);
    const summary = call.removePeer('pAlpha000001');
    expect(summary).toMatchObject({ peer: 'pAlpha000001', failed: false });
    expect(pcs[0]!.closeCalls).toBe(1);
    expect(pcs[1]!.closeCalls).toBe(0);
    expect(call.remoteStream('pAlpha000001')).toBeNull();
    expect(call.remoteStream('pBravo000001')).not.toBeNull();
    expect(call.removePeer('pAlpha000001')).toBeNull();
    expect(localTracks.every((track) => !track.stopped)).toBe(true);
  });

  it('closes every connection once, returns their summaries and keeps the camera on', () => {
    const { call, pcs, localTracks } = setup([peer('pAlpha000001', true), peer('pBravo000001')]);
    const summaries = call.close();
    expect(summaries.map((s) => s.peer)).toEqual(['pAlpha000001', 'pBravo000001']);
    expect(call.close()).toEqual([]);
    expect(pcs.map((pc) => pc.closeCalls)).toEqual([1, 1]);
    expect(localTracks.every((track) => !track.stopped)).toBe(true);
    expect(call.view().participants).toEqual([]);
  });

  it('swaps a new local track into every connection (device change)', async () => {
    const { call, pcs } = setup([peer('pAlpha000001'), peer('pBravo000001')]);
    const camera = new FakeTrack('video', 'usb-camera');
    await call.replaceLocalTrack(camera as unknown as MediaStreamTrack);
    for (const pc of pcs) expect(pc.senders[1]!.track).toBe(camera);
  });

  it('publishes plain, coalesced views (no media objects) and reports failures', async () => {
    const { pcs, views, onFailed } = setup([peer('pAlpha000001', true)]);
    pcs[0]!.fireTrack(new FakeTrack('video'));
    pcs[0]!.setConnectionState('connected');
    await flush();
    expect(views.at(-1)).toEqual({
      sessionId: SESSION,
      topology: 'mesh',
      participants: [
        { participantId: 'pAlpha000001', state: 'connected', quality: null, trackCount: 1 },
      ],
    });
    expect(JSON.parse(JSON.stringify(views.at(-1)))).toEqual(views.at(-1));
    pcs[0]!.setConnectionState('failed');
    pcs[0]!.setConnectionState('failed');
    expect(onFailed).toHaveBeenCalledWith('pAlpha000001');
  });
});
