import { z } from 'zod';

/** The part of the WebSocket API the client uses (the browser's WebSocket, or a test fake). */
export interface JanusSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const OPEN = 1;

export interface Jsep {
  type: 'offer' | 'answer';
  sdp: string;
}

const jsepSchema = z.object({ type: z.enum(['offer', 'answer']), sdp: z.string() });

/** Everything Janus sends that we use (Janus API, `janus-protocol`). */
const messageSchema = z.object({
  janus: z.string(),
  transaction: z.string().optional(),
  session_id: z.number().optional(),
  /** Handle id for handle-level messages. */
  sender: z.number().optional(),
  data: z.object({ id: z.number() }).optional(),
  error: z.object({ code: z.number(), reason: z.string() }).optional(),
  plugindata: z.object({ plugin: z.string(), data: z.record(z.string(), z.unknown()) }).optional(),
  jsep: jsepSchema.optional(),
  reason: z.string().optional(),
});
type JanusMessage = z.output<typeof messageSchema>;

/** Janus refused a request (wrong token, unknown room, …) or a plugin request failed. */
export class JanusError extends Error {
  readonly code: number;

  constructor(code: number, reason: string) {
    super(`Janus error ${String(code)}: ${reason}`);
    this.name = 'JanusError';
    this.code = code;
  }
}

/** The WebSocket to Janus closed or never opened. */
export class JanusConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JanusConnectionError';
  }
}

export interface JanusClientOptions {
  url: string;
  /** Read on every request: Janus checks the signed token each time, so it can be refreshed. */
  token: () => string;
  createSocket?: (url: string, protocol: string) => JanusSocket;
  /** Janus drops sessions without requests for 60 s (session_timeout). */
  keepaliveMs?: number;
  timeoutMs?: number;
}

export interface PluginReply {
  data: Record<string, unknown>;
  jsep?: Jsep;
}

export interface HandleEvents {
  /** Plugin events not answering one of our requests (new publishers, talking, …). */
  onEvent?: (data: Record<string, unknown>, jsep: Jsep | undefined) => void;
  onWebrtcUp?: () => void;
  onHangup?: (reason: string) => void;
}

interface Waiting {
  /** Plugin requests are acked first; the answer is an `event` with the same transaction. */
  expectEvent: boolean;
  resolve: (message: JanusMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let transactionCounter = 0;
const newTransaction = () => {
  transactionCounter += 1;
  return `t${String(transactionCounter)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * A small typed client for the Janus WebSocket API (instead of the vendored janus.js, D-121):
 * one session, plugin handles, transactions matched to their replies (ack → event for plugin
 * requests), keepalives, and `claim` to take the session over on a new connection after a
 * drop (Janus keeps it for `reclaim_session_timeout`). Every message is Zod-validated.
 */
export class JanusClient {
  private readonly opts: JanusClientOptions;
  private socket: JanusSocket | null = null;
  private sessionId: number | null = null;
  private readonly waiting = new Map<string, Waiting>();
  private readonly handles = new Map<number, HandleEvents>();
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  /** The connection closed unexpectedly (not via `destroy`). */
  onClose: (() => void) | null = null;
  /** Janus ended the session (timeout) — only a new session helps. */
  onSessionLost: (() => void) | null = null;

  constructor(opts: JanusClientOptions) {
    this.opts = opts;
  }

  get session(): number | null {
    return this.sessionId;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Opens the WebSocket (`janus-protocol`). */
  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new JanusConnectionError('client destroyed'));
    const create =
      this.opts.createSocket ??
      ((url: string, protocol: string) => new WebSocket(url, protocol) as unknown as JanusSocket);
    return new Promise((resolve, reject) => {
      const socket = create(this.opts.url, 'janus-protocol');
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        socket.close();
        reject(new JanusConnectionError('connect timeout'));
      }, this.opts.timeoutMs ?? 10_000);
      socket.onopen = () => {
        clearTimeout(timer);
        opened = true;
        this.socket = socket;
        resolve();
      };
      socket.onmessage = (event) => {
        this.onMessage(event.data);
      };
      socket.onerror = () => undefined; // `close` follows
      socket.onclose = () => {
        clearTimeout(timer);
        if (!opened) {
          reject(new JanusConnectionError('connection refused'));
          return;
        }
        if (this.socket === socket) this.socket = null;
        this.failAll(new JanusConnectionError('connection closed'));
        this.stopKeepalive();
        if (!this.destroyed) this.onClose?.();
      };
    });
  }

  async createSession(): Promise<number> {
    const reply = await this.request({ janus: 'create' }, false);
    const id = reply.data?.id;
    if (id === undefined) throw new JanusError(0, 'no session id');
    this.sessionId = id;
    this.startKeepalive();
    return id;
  }

  /** Takes over the session on this (new) connection; false if Janus no longer has it. */
  async claim(): Promise<boolean> {
    if (this.sessionId === null) return false;
    try {
      await this.request({ janus: 'claim', session_id: this.sessionId }, false);
      this.startKeepalive();
      return true;
    } catch {
      return false;
    }
  }

  async attach(plugin: string, events: HandleEvents): Promise<JanusHandle> {
    const reply = await this.request(
      { janus: 'attach', session_id: this.sessionId, plugin },
      false,
    );
    const id = reply.data?.id;
    if (id === undefined) throw new JanusError(0, 'no handle id');
    this.handles.set(id, events);
    return new JanusHandle(this, id);
  }

  /** Plugin request; resolves with the plugin's reply (sync `success` or async `event`). */
  async message(
    handleId: number,
    body: Record<string, unknown>,
    jsep?: Jsep,
  ): Promise<PluginReply> {
    const reply = await this.request(
      {
        janus: 'message',
        session_id: this.sessionId,
        handle_id: handleId,
        body,
        ...(jsep === undefined ? {} : { jsep }),
      },
      true,
    );
    const data = reply.plugindata?.data ?? {};
    if (typeof data.error_code === 'number') {
      throw new JanusError(data.error_code, typeof data.error === 'string' ? data.error : 'error');
    }
    return { data, ...(reply.jsep === undefined ? {} : { jsep: reply.jsep }) };
  }

  /** Trickles one candidate (`null` = gathering complete). Fire and forget. */
  trickle(handleId: number, candidate: RTCIceCandidateInit | null): void {
    this.send({
      janus: 'trickle',
      session_id: this.sessionId,
      handle_id: handleId,
      transaction: newTransaction(),
      candidate: candidate ?? { completed: true },
    });
  }

  detach(handleId: number): void {
    this.handles.delete(handleId);
    this.send({
      janus: 'detach',
      session_id: this.sessionId,
      handle_id: handleId,
      transaction: newTransaction(),
    });
  }

  /** Ends the session and closes the connection; idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopKeepalive();
    if (this.sessionId !== null) {
      this.send({ janus: 'destroy', session_id: this.sessionId, transaction: newTransaction() });
    }
    this.failAll(new JanusConnectionError('client destroyed'));
    this.handles.clear();
    this.socket?.close();
    this.socket = null;
  }

  /** Forget the old connection (reconnect with `connect` + `claim` next). */
  dropConnection(): void {
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private request(body: Record<string, unknown>, expectEvent: boolean): Promise<JanusMessage> {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) {
      return Promise.reject(new JanusConnectionError('not connected'));
    }
    const transaction = newTransaction();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(transaction);
        reject(new JanusConnectionError(`${String(body.janus)} timed out`));
      }, this.opts.timeoutMs ?? 10_000);
      this.waiting.set(transaction, { expectEvent, resolve, reject, timer });
      socket.send(JSON.stringify({ ...body, transaction, token: this.opts.token() }));
    });
  }

  private send(body: Record<string, unknown>): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(JSON.stringify({ ...body, token: this.opts.token() }));
  }

  private onMessage(raw: unknown): void {
    let message: JanusMessage;
    try {
      message = messageSchema.parse(JSON.parse(String(raw)));
    } catch {
      return; // not something we understand
    }
    const waiting =
      message.transaction === undefined ? undefined : this.waiting.get(message.transaction);
    if (waiting !== undefined && message.transaction !== undefined) {
      if (message.janus === 'ack' && waiting.expectEvent) return; // the event follows
      this.waiting.delete(message.transaction);
      clearTimeout(waiting.timer);
      if (message.janus === 'error') {
        waiting.reject(new JanusError(message.error?.code ?? 0, message.error?.reason ?? 'error'));
      } else {
        waiting.resolve(message);
      }
      return;
    }
    const handle = message.sender === undefined ? undefined : this.handles.get(message.sender);
    switch (message.janus) {
      case 'event':
        if (message.plugindata !== undefined)
          handle?.onEvent?.(message.plugindata.data, message.jsep);
        break;
      case 'webrtcup':
        handle?.onWebrtcUp?.();
        break;
      case 'hangup':
        handle?.onHangup?.(message.reason ?? 'hangup');
        break;
      case 'timeout':
        this.sessionId = null;
        this.onSessionLost?.();
        break;
      default:
        break; // media, slowlink, detached, keepalive acks …
    }
  }

  private failAll(error: Error): void {
    for (const [transaction, entry] of this.waiting) {
      clearTimeout(entry.timer);
      this.waiting.delete(transaction);
      entry.reject(error);
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.sessionId !== null) {
        this.send({
          janus: 'keepalive',
          session_id: this.sessionId,
          transaction: newTransaction(),
        });
      }
    }, this.opts.keepaliveMs ?? 25_000);
  }

  private stopKeepalive(): void {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }
}

/** One plugin handle of a JanusClient session. */
export class JanusHandle {
  readonly id: number;
  private readonly client: JanusClient;

  constructor(client: JanusClient, id: number) {
    this.client = client;
    this.id = id;
  }

  message(body: Record<string, unknown>, jsep?: Jsep): Promise<PluginReply> {
    return this.client.message(this.id, body, jsep);
  }

  trickle(candidate: RTCIceCandidateInit | null): void {
    this.client.trickle(this.id, candidate);
  }

  detach(): void {
    this.client.detach(this.id);
  }
}
