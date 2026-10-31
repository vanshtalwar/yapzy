import { type MatchFound } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatController } from './chat-controller.ts';
import { createChatStore } from './chat-store.ts';
import { type CallModerationOptions } from './moderation/call-moderation.ts';
import { type CallManager, type CallManagerOptions } from './rtc/call-manager.ts';
import { FakeMediaStream } from './rtc/testing.ts';
import { type RtcSignal } from './rtc/types.ts';
import { type ChatSocket } from './socket.ts';

const SESSION = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';

type Handler = (...args: unknown[]) => void;
type Responder = (payload: unknown) => unknown;

/** Minimal stand-in for a Socket.io client: records emits, lets tests play the server. */
class FakeSocket {
  connected = false;
  active = true;
  emitted: { event: string; payload: unknown }[] = [];
  responders = new Map<string, Responder>();
  private handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  off() {
    this.handlers.clear();
    return this;
  }
  connect() {
    this.connected = true;
    this.server('connect');
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }
  timeout() {
    return {
      emitWithAck: (event: string, payload: unknown) => {
        this.emitted.push({ event, payload });
        const respond = this.responders.get(event);
        return Promise.resolve(respond === undefined ? { ok: true } : respond(payload));
      },
    };
  }
  /** Simulate a server → client event. */
  server(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  sent(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

function match(sessionId = SESSION): MatchFound {
  return {
    sessionId,
    mode: 'text',
    topology: 'mesh',
    maxParticipants: 2,
    selfParticipantId: 'pSelf0000001',
    peers: [{ participantId: 'pPeer0000001', initiator: false, polite: true }],
    moderation: { frameIntervalMs: null },
    commonInterests: [],
  };
}

function setup() {
  const socket = new FakeSocket();
  const store = createChatStore({
    mode: 'text',
    lang: 'en',
    interests: ['music'],
    autoRequeue: false,
  });
  const doc = Object.assign(new EventTarget(), { hidden: false }) as unknown as Document;
  const controller = createChatController({
    store,
    socket: socket as unknown as ChatSocket,
    document: doc,
    ghostTabMs: 60_000,
  });
  return { socket, store, controller, doc };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('chat controller', () => {
  it('joins with the stored preferences and acks a match immediately', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    expect(socket.sent('queue:join')).toEqual([
      { mode: 'text', lang: 'en', interests: ['music'], autoRequeue: false },
    ]);
    expect(store.getState().status).toBe('waiting');

    socket.server('match:found', match());
    await flush();
    expect(store.getState().status).toBe('matched');
    expect(socket.sent('match:ack')).toEqual([{ sessionId: SESSION }]);
  });

  it('declines a match that raced a Stop', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    await controller.stop();
    socket.server('match:found', match());
    await flush();
    expect(store.getState().status).toBe('idle');
    expect(socket.sent('chat:end')).toEqual([{ sessionId: SESSION }]);
    expect(socket.sent('match:ack')).toEqual([]);
  });

  it('resumes after a reconnect from the cursor it had when the connection dropped', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('match:found', match());
    socket.server('chat:message', {
      sessionId: SESSION,
      from: 'pPeer0000001',
      id: '01A',
      text: 'one',
      at: '2026-10-31T12:00:00.000Z',
    });
    socket.server('disconnect', 'transport close');
    expect(store.getState().connectionLost).toBe(true);

    socket.responders.set('session:resume', () => ({
      ok: true,
      data: {
        selfParticipantId: 'pSelf0000001',
        peers: [{ participantId: 'pPeer0000001', initiator: false, polite: true }],
        missedMessages: [
          {
            sessionId: SESSION,
            from: 'pPeer0000001',
            id: '01B',
            text: 'two',
            at: '2026-10-31T12:00:01.000Z',
          },
        ],
      },
    }));
    socket.server('connect');
    await flush();
    expect(socket.sent('session:resume')).toEqual([{ sessionId: SESSION, lastMessageId: '01A' }]);
    expect(
      store
        .getState()
        .entries.filter((e) => e.kind === 'stranger')
        .map((e) => e.text),
    ).toEqual(['one', 'two']);
    expect(store.getState().status).toBe('matched'); // a reconnect never resets the chat
  });

  it('treats SESSION_NOT_RESUMABLE as the chat having ended', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('match:found', match());
    socket.server('disconnect', 'transport close');
    socket.responders.set('session:resume', () => ({
      ok: false,
      error: { code: 'SESSION_NOT_RESUMABLE', message: 'gone' },
    }));
    socket.server('connect');
    await flush();
    expect(store.getState()).toMatchObject({ status: 'ended', endReason: 'expired' });
  });

  it('pauses searching after the tab was hidden for 60 s (ghost-tab protection)', async () => {
    vi.useFakeTimers();
    const { socket, store, controller, doc } = setup();
    controller.start();
    await vi.runOnlyPendingTimersAsync();
    expect(store.getState().status).toBe('waiting');

    (doc as unknown as { hidden: boolean }).hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(store.getState().status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState()).toMatchObject({ status: 'idle', paused: true });
    expect(socket.sent('queue:leave')).toEqual([{}]);
  });

  it('stops reconnecting after SESSION_REPLACED', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('system:notice', { code: 'SESSION_REPLACED', message: 'other tab' });
    expect(store.getState()).toMatchObject({ status: 'error', errorKind: 'replaced' });
    const connect = vi.spyOn(socket, 'connect');
    socket.server('disconnect', 'io server disconnect');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps asking to skip when the gateway throttles rapid skipping', async () => {
    vi.useFakeTimers();
    const { socket, store, controller } = setup();
    controller.start();
    await vi.runOnlyPendingTimersAsync();
    socket.server('match:found', match());
    let refusals = 2;
    socket.responders.set('chat:next', () =>
      refusals-- > 0
        ? { ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } }
        : { ok: true },
    );
    await controller.next();
    expect(store.getState().status).toBe('connecting'); // UI moved on, server not yet
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().status).toBe('waiting');
    expect(socket.sent('chat:next')).toHaveLength(3);
  });

  it('ends the not-yet-skipped chat when the user stops while a skip is throttled', async () => {
    vi.useFakeTimers();
    const { socket, store, controller } = setup();
    controller.start();
    await vi.runOnlyPendingTimersAsync();
    socket.server('match:found', match());
    socket.responders.set('chat:next', () => ({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Slow down' },
    }));
    await controller.next();
    await controller.stop();
    expect(store.getState().status).toBe('idle');
    expect(socket.sent('chat:end')).toEqual([{ sessionId: SESSION }]);
    expect(socket.sent('queue:leave')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.sent('chat:next')).toHaveLength(1); // no retries after stopping
  });

  it('moves to another gateway node as soon as its node announces a restart', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('match:found', match());
    socket.responders.set('session:resume', () => ({
      ok: true,
      data: { selfParticipantId: 'pSelf0000001', peers: match().peers, missedMessages: [] },
    }));
    const connect = vi.spyOn(socket, 'connect');
    socket.server('system:notice', { code: 'SERVER_RESTARTING', message: 'deploy' });
    expect(socket.connected).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('matched'); // the chat itself continues
  });

  it('drops malformed server payloads instead of acting on them', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('match:found', { ...match(), sessionId: 'not-a-uuid' });
    expect(store.getState().status).toBe('waiting');
    expect(socket.sent('match:ack')).toEqual([]);
    socket.server('match:found', match());
    socket.server('chat:message', { sessionId: SESSION, text: 'no id or sender' });
    expect(store.getState().entries.filter((e) => e.kind === 'stranger')).toEqual([]);
  });

  it('sends messages optimistically and reconciles failures', async () => {
    const { socket, store, controller } = setup();
    controller.start();
    await flush();
    socket.server('match:found', match());
    socket.responders.set('chat:message', () => ({
      ok: true,
      data: { id: '01SRV', at: '2026-10-31T12:00:05.000Z' },
    }));
    expect(controller.send('  hello  ')).toBe(true);
    expect(store.getState().entries.at(-1)).toMatchObject({ status: 'sending', text: 'hello' });
    await flush();
    expect(store.getState().entries.at(-1)).toMatchObject({ status: 'sent', id: '01SRV' });

    socket.responders.set('chat:message', () => ({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'slow' },
    }));
    controller.send('again');
    await flush();
    expect(store.getState().entries.at(-1)).toMatchObject({ status: 'failed' });
    expect(controller.send('   ')).toBe(false);
  });
});

// --- video (Part 7) ------------------------------------------------------------------------

interface FakeCall {
  sessionId: string;
  options: CallManagerOptions;
  signals: RtcSignal[];
  closed: number;
  recovered: number;
  removed: string[];
  iceServers: RTCIceServer[][];
  tracks: unknown[];
}

function setupVideo(opts: { stream?: boolean } = {}) {
  const socket = new FakeSocket();
  const store = createChatStore({ mode: 'video', lang: 'en', interests: [], autoRequeue: true });
  const calls: FakeCall[] = [];
  const order: string[] = [];
  const trackListeners: ((track: MediaStreamTrack) => void)[] = [];
  const stream = opts.stream === false ? null : (new FakeMediaStream() as unknown as MediaStream);
  const target = new EventTarget();
  const notices: string[] = [];
  const moderation = {
    created: [] as CallModerationOptions[],
    schedules: [] as unknown[],
    stopped: 0,
    evidence: [new Blob(['f1']), new Blob(['f2'])],
  };
  const reports: { fields: unknown; frames: Blob[] }[] = [];
  const controller = createChatController({
    store,
    socket: socket as unknown as ChatSocket,
    document: Object.assign(new EventTarget(), { hidden: false }) as unknown as Document,
    window: target,
    notify: (message) => notices.push(message),
    reports: {
      submit: (fields, frames) => {
        reports.push({ fields, frames });
        return Promise.resolve();
      },
    },
    video: {
      localMedia: {
        getStream: () => stream,
        onTrackReplaced: (listener) => {
          trackListeners.push(listener);
          return () => undefined;
        },
      },
      iceServers: {
        get: () => Promise.resolve([{ urls: ['stun:localhost:3478'] }]),
        peek: () => [{ urls: ['stun:localhost:3478'] }],
        refreshInMs: () => 600_000,
      },
      forceRelay: false,
      moderation: {
        create: (options) => {
          moderation.created.push(options);
          return {
            setSchedule: (schedule) => moderation.schedules.push(schedule),
            evidence: () => moderation.evidence,
            stop: () => (moderation.stopped += 1),
          };
        },
      },
      createCall: (options) => {
        order.push('createCall');
        const fake: FakeCall = {
          sessionId: options.sessionId,
          options,
          signals: [],
          closed: 0,
          recovered: 0,
          removed: [],
          iceServers: [],
          tracks: [],
        };
        calls.push(fake);
        return {
          sessionId: options.sessionId,
          handleSignal: (signal: RtcSignal) => fake.signals.push(signal),
          removePeer: (participantId: string) => {
            fake.removed.push(participantId);
            return null;
          },
          remoteStream: () => null,
          view: () => ({ sessionId: options.sessionId, topology: 'mesh', participants: [] }),
          replaceLocalTrack: (track: unknown) => {
            fake.tracks.push(track);
            return Promise.resolve();
          },
          setIceServers: (servers: RTCIceServer[]) => fake.iceServers.push(servers),
          recover: () => (fake.recovered += 1),
          close: () => {
            fake.closed += 1;
            return fake.closed === 1
              ? [
                  {
                    peer: 'pPeer0000001',
                    localCandidateType: 'host' as const,
                    remoteCandidateType: 'host' as const,
                    avgRttMs: 3,
                    avgBitrateKbps: 750,
                    timeToConnectedMs: 400,
                    failed: false,
                  },
                ]
              : [];
          },
        } as unknown as CallManager;
      },
    },
  });
  const originalTimeout = socket.timeout.bind(socket);
  socket.timeout = () => {
    const timed = originalTimeout();
    return {
      emitWithAck: (event: string, payload: unknown) => {
        order.push(event);
        return timed.emitWithAck(event, payload);
      },
    };
  };
  return {
    socket,
    store,
    controller,
    calls,
    order,
    trackListeners,
    target,
    notices,
    moderation,
    reports,
  };
}

const videoMatch = (sessionId = SESSION): MatchFound => ({ ...match(sessionId), mode: 'video' });

describe('chat controller — video', () => {
  it('never joins the video queue without camera and microphone', async () => {
    const { socket, store, controller } = setupVideo({ stream: false });
    controller.start();
    await flush();
    expect(socket.sent('queue:join')).toEqual([]);
    expect(store.getState()).toMatchObject({ status: 'error', errorKind: 'unknown' });
  });

  it('creates the call before acknowledging the match and routes signals to it', async () => {
    const { socket, controller, calls, order } = setupVideo();
    controller.start();
    await flush();
    expect(socket.sent('queue:join')).toEqual([
      { mode: 'video', lang: 'en', interests: [], autoRequeue: true },
    ]);
    socket.server('match:found', videoMatch());
    await flush();
    expect(order.slice(-2)).toEqual(['createCall', 'match:ack']);
    expect(calls[0]!.options.peers).toEqual(videoMatch().peers);

    socket.server('rtc:offer', { sessionId: SESSION, from: 'pPeer0000001', sdp: 'v=0' });
    socket.server('rtc:ice', {
      sessionId: SESSION,
      from: 'pPeer0000001',
      candidate: { candidate: 'candidate:1' },
    });
    expect(calls[0]!.signals.map((s) => s.kind)).toEqual(['offer', 'ice']);

    // Outgoing signaling is tagged with the session and the recipient.
    calls[0]!.options.signaling.description('pPeer0000001', 'answer', 'v=1');
    calls[0]!.options.signaling.candidate('pPeer0000001', {
      candidate: 'candidate:2',
      sdpMid: '0',
    });
    expect(socket.sent('rtc:answer')).toEqual([
      { sessionId: SESSION, to: 'pPeer0000001', sdp: 'v=1' },
    ]);
    expect(socket.sent('rtc:ice')).toEqual([
      {
        sessionId: SESSION,
        to: 'pPeer0000001',
        candidate: {
          candidate: 'candidate:2',
          sdpMid: '0',
          sdpMLineIndex: undefined,
          usernameFragment: undefined,
        },
      },
    ]);
  });

  it('closes the call and reports its summary when skipping, then searches again', async () => {
    const { socket, controller, calls } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', videoMatch());
    await controller.next();
    expect(calls[0]!.closed).toBe(1);
    expect(socket.sent('rtc:summary')).toEqual([
      expect.objectContaining({ sessionId: SESSION, peer: 'pPeer0000001', failed: false }),
    ]);
    expect(socket.sent('chat:next')).toEqual([{ sessionId: SESSION }]);
  });

  it('ends the session with rtc_failed when the media connection cannot be established', async () => {
    const { socket, controller, calls, store } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', videoMatch());
    calls[0]!.options.onFailed('pPeer0000001');
    await flush();
    expect(socket.sent('chat:next')).toEqual([{ sessionId: SESSION, reason: 'rtc_failed' }]);
    expect(calls[0]!.closed).toBe(1);
    expect(store.getState().status).toBe('waiting');
  });

  it('keeps the call through a socket reconnect and repairs it after resuming', async () => {
    const { socket, controller, calls } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', videoMatch());
    socket.server('disconnect', 'transport close');
    expect(calls[0]!.closed).toBe(0);
    socket.responders.set('session:resume', () => ({
      ok: true,
      data: { selfParticipantId: 'pSelf0000001', peers: videoMatch().peers, missedMessages: [] },
    }));
    socket.server('connect');
    await flush();
    expect(calls[0]!.closed).toBe(0);
    expect(calls[0]!.recovered).toBe(1);
  });

  it('closes the call when the stranger leaves, and on page unload ends the chat', async () => {
    const first = setupVideo();
    first.controller.start();
    await flush();
    first.socket.server('match:found', videoMatch());
    first.socket.server('peer:left', {
      sessionId: SESSION,
      participantId: 'pPeer0000001',
      reason: 'left',
      sessionEnded: true,
    });
    expect(first.calls[0]!.closed).toBe(1);
    expect(first.socket.sent('rtc:summary')).toHaveLength(1);

    const second = setupVideo();
    second.controller.start();
    await flush();
    second.socket.server('match:found', videoMatch());
    second.target.dispatchEvent(new Event('pagehide'));
    expect(second.calls[0]!.closed).toBe(1);
    expect(second.socket.sent('chat:end')).toEqual([{ sessionId: SESSION }]);
  });

  it('swaps a new camera/mic track into the running call', async () => {
    const { socket, controller, calls, trackListeners } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', videoMatch());
    const track = { kind: 'video' } as MediaStreamTrack;
    for (const listener of trackListeners) listener(track);
    expect(calls[0]!.tracks).toEqual([track]);
  });

  it('starts moderation with the call and applies schedule changes from the server', async () => {
    const { socket, controller, moderation } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', {
      ...videoMatch(),
      moderation: { frameIntervalMs: 30_000, maxFrames: null },
    });
    expect(moderation.created).toHaveLength(1);
    expect(moderation.created[0]).toMatchObject({
      sessionId: SESSION,
      schedule: { frameIntervalMs: 30_000 },
    });
    socket.server('system:notice', {
      code: 'FRAME_SCHEDULE',
      message: 'raised',
      sessionId: SESSION,
      moderation: { frameIntervalMs: 20_000, maxFrames: null },
    });
    socket.server('system:notice', {
      code: 'FRAME_SCHEDULE',
      message: 'stale',
      sessionId: '0199a3b2-7c4d-7e5f-8a9b-000000000000',
      moderation: { frameIntervalMs: 1_000 },
    });
    expect(moderation.schedules).toEqual([{ frameIntervalMs: 20_000, maxFrames: null }]);
    // A client NSFW verdict becomes a moderation:signal about the stranger.
    moderation.created[0]?.signal({ flagged: true, kind: 'porn', score: 0.97 });
    expect(socket.sent('moderation:signal')).toEqual([
      { sessionId: SESSION, about: 'pPeer0000001', kind: 'porn', score: 0.97 },
    ]);
    await controller.stop();
    expect(moderation.stopped).toBe(1);
  });

  it('reports the stranger with the evidence frames, then moves on', async () => {
    const { socket, controller, reports, notices, moderation } = setupVideo();
    controller.start();
    await flush();
    socket.server('match:found', videoMatch());
    await controller.report({ reason: 'NUDITY_SEXUAL', details: '  explicit  ' });
    expect(reports).toEqual([
      {
        fields: {
          sessionId: SESSION,
          reportedParticipantId: 'pPeer0000001',
          reason: 'NUDITY_SEXUAL',
          details: 'explicit',
        },
        frames: moderation.evidence,
      },
    ]);
    expect(notices).toContain('Thanks for reporting — our team will review it.');
    expect(socket.sent('chat:next')).toEqual([{ sessionId: SESSION }]);
    expect(moderation.stopped).toBe(1);
  });

  it('shows why a message was blocked', async () => {
    const { socket, controller, notices } = setupVideo();
    controller.start();
    await flush();
    socket.server('system:notice', {
      code: 'MESSAGE_BLOCKED',
      message: 'Links aren’t allowed in chat.',
    });
    expect(notices).toEqual(['Links aren’t allowed in chat.']);
  });
});
