import { type ChatMessageOut, type MatchFound } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { createChatStore, strangerName } from './chat-store.ts';

const SESSION = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0199a3b2-7c4d-7e5f-8a9b-000000000000';

function match(sessionId = SESSION, commonInterests: string[] = []): MatchFound {
  return {
    sessionId,
    mode: 'text',
    topology: 'mesh',
    maxParticipants: 2,
    selfParticipantId: 'pSelf0000001',
    peers: [{ participantId: 'pPeer0000001', initiator: true, polite: false }],
    moderation: { frameIntervalMs: null },
    commonInterests,
  };
}

function message(id: string, sessionId = SESSION, text = 'hi'): ChatMessageOut {
  return { sessionId, from: 'pPeer0000001', id, text, at: '2026-10-31T12:00:00.000Z' };
}

function matchedStore() {
  const store = createChatStore();
  store.getState().startSearch();
  store.getState().waiting();
  expect(store.getState().matchFound(match())).toBe(true);
  return store;
}

describe('chat state machine', () => {
  it('walks idle → connecting → waiting → matched → ended → connecting', () => {
    const store = createChatStore();
    const s = () => store.getState();
    expect(s().status).toBe('idle');
    s().startSearch();
    expect(s().status).toBe('connecting');
    s().waiting();
    expect(s().status).toBe('waiting');
    expect(s().matchFound(match(SESSION, ['music']))).toBe(true);
    expect(s().status).toBe('matched');
    expect(s().entries.map((e) => e.kind === 'system' && e.text)).toEqual([
      "You're now chatting with a random stranger. Say hi!",
      'You both like: music.',
    ]);
    s().peerLeft({
      sessionId: SESSION,
      participantId: 'pPeer0000001',
      reason: 'disconnected',
      sessionEnded: true,
    });
    expect(s().status).toBe('ended');
    expect(s().endReason).toBe('peer_disconnected');
    s().startSearch();
    expect(s()).toMatchObject({ status: 'connecting', sessionId: null, entries: [] });
  });

  it('declines a match that arrives after the user stopped searching', () => {
    const store = createChatStore();
    store.getState().startSearch();
    store.getState().stopSearching();
    expect(store.getState().status).toBe('idle');
    expect(store.getState().matchFound(match())).toBe(false);
    expect(store.getState().sessionId).toBeNull();
  });

  it('accepts a server-side requeue match after a chat ended (fair requeue)', () => {
    const store = matchedStore();
    store.getState().peerLeft({
      sessionId: SESSION,
      participantId: 'pPeer0000001',
      reason: 'left',
      sessionEnded: true,
    });
    store.getState().waiting(); // the server put us back in the queue
    expect(store.getState()).toMatchObject({ status: 'waiting', entries: [] });
    expect(store.getState().matchFound(match(OTHER))).toBe(true);
    expect(store.getState().sessionId).toBe(OTHER);
  });

  it('ignores every event of a session that is not the current one', () => {
    const store = matchedStore();
    const before = store.getState().entries.length;
    store.getState().receiveMessage(message('m1', OTHER));
    store.getState().setPeerTyping({ sessionId: OTHER, from: 'x', isTyping: true });
    store.getState().peerReconnecting({ sessionId: OTHER, participantId: 'x' });
    store
      .getState()
      .peerLeft({ sessionId: OTHER, participantId: 'x', reason: 'left', sessionEnded: true });
    expect(store.getState()).toMatchObject({
      status: 'matched',
      peerTyping: false,
      peerUnstable: false,
    });
    expect(store.getState().entries).toHaveLength(before);
  });

  it('dedupes stranger messages and tracks the resume cursor', () => {
    const store = matchedStore();
    store.getState().receiveMessage(message('01A'));
    store.getState().receiveMessage(message('01A'));
    expect(store.getState().entries.filter((e) => e.kind === 'stranger')).toHaveLength(1);
    expect(store.getState().lastReceivedId).toBe('01A');

    store.getState().setConnectionLost(true);
    store.getState().receiveMessage(message('01B')); // arrives live after reconnecting
    expect(store.getState().resumeCursor).toBe('01A'); // snapshot from the drop, not later
  });

  it('reconciles optimistic messages with acks, failures, retries and blocks', () => {
    const store = matchedStore();
    const s = () => store.getState();
    expect(s().addOutgoing('hello', 'c1')).toEqual({ sessionId: SESSION });
    expect(s().entries.at(-1)).toMatchObject({ kind: 'self', status: 'sending', id: 'c1' });

    s().ackMessage('c1', { id: '01SERVER', at: '2026-10-31T12:00:01.000Z' });
    expect(s().entries.at(-1)).toMatchObject({ status: 'sent', id: '01SERVER', clientMsgId: 'c1' });

    s().addOutgoing('holy shit', 'c0');
    s().ackMessage('c0', { id: '01MASKED', at: '2026-10-31T12:00:01.500Z', text: 'holy ****' });
    expect(s().entries.at(-1)).toMatchObject({ status: 'sent', text: 'holy ****' });

    s().addOutgoing('lost', 'c2');
    s().failMessage('c2', 'SERVICE_UNAVAILABLE');
    expect(s().entries.at(-1)).toMatchObject({ status: 'failed' });
    expect(s().retryMessage('c2')).toEqual({ sessionId: SESSION, text: 'lost' });
    expect(s().entries.at(-1)).toMatchObject({ status: 'sending' });
    expect(s().retryMessage('c2')).toBeNull(); // only failed messages can be retried

    s().addOutgoing('rude', 'c3');
    s().failMessage('c3', 'MESSAGE_BLOCKED');
    expect(s().entries.at(-1)).toMatchObject({ status: 'blocked' });
  });

  it('only sends while matched', () => {
    const store = createChatStore();
    expect(store.getState().addOutgoing('hi', 'c1')).toBeNull();
  });

  it('merges missed messages on resume without duplicates', () => {
    const store = matchedStore();
    store.getState().receiveMessage(message('01A', SESSION, 'one'));
    store.getState().setConnectionLost(true);
    store.getState().resumed({
      selfParticipantId: 'pSelf0000001',
      peers: [{ participantId: 'pPeer0000001', initiator: true, polite: false }],
      missedMessages: [
        message('01A', SESSION, 'one'),
        message('01B', SESSION, 'two'),
        message('01C', OTHER, 'x'),
      ],
    });
    const texts = store
      .getState()
      .entries.filter((e) => e.kind === 'stranger')
      .map((e) => e.text);
    expect(texts).toEqual(['one', 'two']);
    expect(store.getState()).toMatchObject({ connectionLost: false, lastReceivedId: '01B' });
  });

  it('pauses only while waiting and marks resume failures as ended', () => {
    const store = createChatStore();
    store.getState().pause();
    expect(store.getState().paused).toBe(false);
    store.getState().startSearch();
    store.getState().waiting();
    store.getState().pause();
    expect(store.getState()).toMatchObject({ status: 'idle', paused: true });

    const matched = matchedStore();
    matched.getState().sessionExpired();
    expect(matched.getState()).toMatchObject({ status: 'ended', endReason: 'expired' });
  });
});

describe('group calls (Part 12)', () => {
  const SESSION_ID = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
  it('numbers strangers stably, frees numbers on leave and names authors', () => {
    const store = createChatStore();
    store.getState().startSearch();
    store.getState().matchFound(match(SESSION_ID));
    expect(strangerName(store.getState(), 'pPeer0000001')).toBe('Stranger'); // 1:1
    store.getState().peerJoined({ sessionId: SESSION_ID, participantId: 'pJoin0000001' });
    store.getState().peerJoined({ sessionId: SESSION_ID, participantId: 'pJoin0000002' });
    expect(store.getState().peerLabels).toEqual({
      pPeer0000001: 1,
      pJoin0000001: 2,
      pJoin0000002: 3,
    });
    expect(strangerName(store.getState(), 'pJoin0000001')).toBe('Stranger 2');
    store.getState().peerLeft({
      sessionId: SESSION_ID,
      participantId: 'pPeer0000001',
      reason: 'left',
      sessionEnded: false,
    });
    expect(store.getState().status).toBe('matched'); // the others stay
    store.getState().peerJoined({ sessionId: SESSION_ID, participantId: 'pJoin0000003' });
    expect(store.getState().peerLabels.pJoin0000003).toBe(1); // the freed number
    store.getState().receiveMessage({
      sessionId: SESSION_ID,
      from: 'pJoin0000002',
      id: 'm1',
      text: 'hello',
      at: new Date().toISOString(),
    });
    expect(store.getState().entries.at(-1)).toMatchObject({
      kind: 'stranger',
      from: 'pJoin0000002',
    });
  });

  it('tracks the add-a-person round and the search', () => {
    const store = createChatStore();
    store.getState().startSearch();
    store.getState().matchFound(match(SESSION_ID));
    const expiresAt = new Date(Date.now() + 15_000).toISOString();
    store
      .getState()
      .addRequested(
        { sessionId: SESSION_ID, requestId: 'rRound000001', by: 'pSelf0000001', expiresAt },
        'pSelf0000001',
      );
    expect(store.getState().addRequest).toMatchObject({ answered: true }); // we asked
    expect(store.getState().seekCancelled({ sessionId: SESSION_ID, reason: 'declined' })).toBe(
      'declined',
    );
    expect(store.getState().addRequest).toBeNull();
    expect(
      store.getState().seekCancelled({ sessionId: SESSION_ID, reason: 'declined' }),
    ).toBeNull();
    store.getState().seekStarted({ sessionId: SESSION_ID, until: expiresAt });
    expect(store.getState().seekingUntil).toBe(expiresAt);
    store.getState().peerJoined({ sessionId: SESSION_ID, participantId: 'pJoin0000001' });
    expect(store.getState().seekingUntil).toBeNull();
  });
});
