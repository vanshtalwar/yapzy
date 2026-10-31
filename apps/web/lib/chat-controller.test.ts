import { type MatchFound } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatController } from './chat-controller.ts';
import { createChatStore } from './chat-store.ts';
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
