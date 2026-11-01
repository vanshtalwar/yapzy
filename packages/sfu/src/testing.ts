import { type AdminSocket } from './admin-client.ts';

interface FakeRoom {
  secret: string;
  allowed: Set<string>;
  /** Janus publisher id → display (participantId). */
  participants: Map<number, string>;
  bitrate: number;
  publishers: number;
}

interface Request {
  request: string;
  body: Record<string, unknown>;
}

/**
 * In-memory stand-in for one Janus node's Admin API (tests): understands `ping` and the
 * VideoRoom requests we send through `message_plugin`, checks the admin secret, admin key and
 * room secrets like Janus does, and can be taken down (`setDown`) to test health and failover.
 */
export function createFakeJanus(options: { adminSecret: string }) {
  const rooms = new Map<number, FakeRoom>();
  const sockets = new Set<FakeSocket>();
  const requests: Request[] = [];
  let down = false;
  let nextPublisherId = 1_000;

  class FakeSocket implements AdminSocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;

    constructor() {
      setTimeout(() => {
        if (down) {
          this.readyState = 3;
          this.onerror?.({});
          this.onclose?.({});
          return;
        }
        this.readyState = 1;
        sockets.add(this);
        this.onopen?.({});
      }, 0);
    }

    send(data: string): void {
      const message = JSON.parse(data) as Record<string, unknown>;
      const reply = answer(message);
      setTimeout(() => {
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(reply) });
      }, 0);
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      setTimeout(() => this.onclose?.({}), 0);
    }
  }

  function videoroom(body: Record<string, unknown>): Record<string, unknown> {
    const fail = (code: number, error: string) => ({ videoroom: 'event', error_code: code, error });
    const request = String(body.request);
    requests.push({ request, body });
    const roomId = Number(body.room);
    const room = rooms.get(roomId);
    const secretOk = room !== undefined && body.secret === room.secret;
    switch (request) {
      case 'create': {
        if (body.admin_key !== options.adminSecret)
          return fail(429, 'Missing mandatory element (admin_key)');
        if (rooms.has(roomId)) return fail(427, 'Room exists');
        rooms.set(roomId, {
          secret: String(body.secret),
          allowed: new Set((body.allowed as string[] | undefined) ?? []),
          participants: new Map(),
          bitrate: Number(body.bitrate),
          publishers: Number(body.publishers),
        });
        return { videoroom: 'created', room: roomId, permanent: false };
      }
      case 'destroy':
        if (room === undefined) return fail(426, 'No such room');
        if (!secretOk) return fail(433, 'Unauthorized (wrong secret)');
        rooms.delete(roomId);
        return { videoroom: 'destroyed', room: roomId };
      case 'allowed': {
        if (room === undefined) return fail(426, 'No such room');
        if (!secretOk) return fail(433, 'Unauthorized (wrong secret)');
        const tokens = (body.allowed as string[] | undefined) ?? [];
        for (const token of tokens) {
          if (body.action === 'add') room.allowed.add(token);
          else room.allowed.delete(token);
        }
        return { videoroom: 'success', room: roomId, allowed: [...room.allowed] };
      }
      case 'kick':
        if (room === undefined) return fail(426, 'No such room');
        if (!secretOk) return fail(433, 'Unauthorized (wrong secret)');
        if (!room.participants.delete(Number(body.id))) return fail(428, 'No such user');
        return { videoroom: 'success' };
      case 'listparticipants':
        if (room === undefined) return fail(426, 'No such room');
        return {
          videoroom: 'participants',
          room: roomId,
          participants: [...room.participants].map(([id, display]) => ({
            id,
            display,
            publisher: true,
          })),
        };
      case 'list':
        if (body.admin_key !== options.adminSecret) return fail(433, 'Unauthorized');
        return { videoroom: 'success', list: [...rooms.keys()].map((id) => ({ room: id })) };
      default:
        return fail(423, `Unknown request '${request}'`);
    }
  }

  function answer(message: Record<string, unknown>): Record<string, unknown> {
    const { transaction } = message;
    if (message.janus === 'ping') return { janus: 'pong', transaction };
    if (message.admin_secret !== options.adminSecret) {
      return { janus: 'error', transaction, error: { code: 403, reason: 'Unauthorized request' } };
    }
    if (message.janus === 'message_plugin' && message.plugin === 'janus.plugin.videoroom') {
      return {
        janus: 'success',
        transaction,
        response: videoroom(message.request as Record<string, unknown>),
      };
    }
    return { janus: 'error', transaction, error: { code: 457, reason: 'Unhandled request' } };
  }

  return {
    rooms,
    requests,
    createSocket: (): AdminSocket => new FakeSocket(),

    /** Down: open connections close and new ones are refused (like a stopped container). */
    setDown(value: boolean): void {
      down = value;
      if (value) for (const socket of [...sockets]) socket.close();
    },

    /** A browser joined `roomId` as publisher `display`; returns its Janus publisher id. */
    join(roomId: number, display: string): number {
      const room = rooms.get(roomId);
      if (room === undefined) throw new Error(`no room ${String(roomId)}`);
      nextPublisherId += 1;
      room.participants.set(nextPublisherId, display);
      return nextPublisherId;
    },

    requestsOf(name: string): Record<string, unknown>[] {
      return requests.filter((entry) => entry.request === name).map((entry) => entry.body);
    },
  };
}

export type FakeJanus = ReturnType<typeof createFakeJanus>;
