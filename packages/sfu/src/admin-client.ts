import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/** The part of the WebSocket API the client uses (Node's global WebSocket, or a test fake). */
export interface AdminSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const OPEN = 1;

export interface JanusAdminClientOptions {
  /** Admin API WebSocket URL, e.g. ws://localhost:7188. */
  url: string;
  /** Janus `admin_secret`. */
  secret: string;
  /** Per request (and per connection attempt). */
  timeoutMs?: number;
  /** Latency of every request, for metrics. */
  onRequest?: (request: string, durationMs: number, outcome: 'ok' | 'error') => void;
  /** The connection closed (Janus stopped or restarted): lets the health checker look now. */
  onClose?: () => void;
  createSocket?: (url: string, protocol: string) => AdminSocket;
}

/** Janus answered, but with an error (wrong secret, unknown room, …). */
export class JanusAdminError extends Error {
  readonly code: number;

  constructor(code: number, reason: string) {
    super(`Janus error ${String(code)}: ${reason}`);
    this.name = 'JanusAdminError';
    this.code = code;
  }
}

/** Janus could not be reached (connection refused/closed, timeout). */
export class JanusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JanusUnavailableError';
  }
}

const replySchema = z.object({
  janus: z.string(),
  transaction: z.string(),
  response: z.unknown().optional(),
  error: z.object({ code: z.number(), reason: z.string() }).optional(),
});
type Reply = z.output<typeof replySchema>;

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Client for the Janus Admin API over WebSocket (`janus-admin-protocol`): one lazily opened
 * connection, requests matched to replies by transaction id, a timeout per request, and a
 * fresh connection on the next request after the old one closed. Replies are validated with
 * Zod; anything that doesn't match is dropped.
 */
export function createJanusAdminClient(options: JanusAdminClientOptions) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const createSocket =
    options.createSocket ??
    ((url: string, protocol: string) => new WebSocket(url, protocol) as unknown as AdminSocket);
  const pending = new Map<string, Pending>();
  let socket: AdminSocket | null = null;
  let connecting: Promise<AdminSocket> | null = null;
  let closed = false;

  function failAll(error: Error): void {
    for (const [transaction, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(transaction);
      entry.reject(error);
    }
  }

  function onMessage(data: unknown): void {
    let parsed: Reply;
    try {
      parsed = replySchema.parse(JSON.parse(String(data)));
    } catch {
      return; // not a reply of ours
    }
    const entry = pending.get(parsed.transaction);
    if (entry === undefined) return;
    pending.delete(parsed.transaction);
    clearTimeout(entry.timer);
    entry.resolve(parsed);
  }

  function connect(): Promise<AdminSocket> {
    if (closed) return Promise.reject(new JanusUnavailableError('client closed'));
    if (socket?.readyState === OPEN) return Promise.resolve(socket);
    connecting ??= new Promise<AdminSocket>((resolve, reject) => {
      let settled = false;
      const ws = createSocket(options.url, 'janus-admin-protocol');
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new JanusUnavailableError('connect timeout'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        socket = ws;
        resolve(ws);
      };
      ws.onmessage = (event) => {
        onMessage(event.data);
      };
      ws.onerror = () => {
        // `close` follows; it does the clean-up.
      };
      ws.onclose = () => {
        clearTimeout(timer);
        const wasOpen = socket === ws;
        if (wasOpen) socket = null;
        failAll(new JanusUnavailableError('connection closed'));
        if (!settled) {
          settled = true;
          reject(new JanusUnavailableError('connection refused'));
        }
        if (wasOpen) options.onClose?.();
      };
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function request(
    label: string,
    body: Record<string, unknown>,
    expect: 'success' | 'pong',
  ): Promise<Reply> {
    const started = performance.now();
    try {
      const ws = await connect();
      const transaction = randomUUID();
      const reply = await new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(transaction);
          reject(new JanusUnavailableError(`${label} timed out`));
        }, timeoutMs);
        pending.set(transaction, { resolve, reject, timer });
        ws.send(JSON.stringify({ ...body, transaction, admin_secret: options.secret }));
      });
      if (reply.janus === 'error') {
        throw new JanusAdminError(reply.error?.code ?? 0, reply.error?.reason ?? 'unknown error');
      }
      if (reply.janus !== expect) {
        throw new JanusAdminError(0, `unexpected reply "${reply.janus}"`);
      }
      options.onRequest?.(label, performance.now() - started, 'ok');
      return reply;
    } catch (error) {
      options.onRequest?.(label, performance.now() - started, 'error');
      throw error;
    }
  }

  return {
    url: options.url,

    /** Unauthenticated liveness check (Janus answers `pong` without the secret). */
    async ping(): Promise<void> {
      await request('ping', { janus: 'ping' }, 'pong');
    },

    /** A synchronous plugin request (`message_plugin`); returns the plugin's response body. */
    async messagePlugin(plugin: string, body: Record<string, unknown>): Promise<unknown> {
      const label = typeof body.request === 'string' ? body.request : 'message_plugin';
      const reply = await request(label, { janus: 'message_plugin', plugin, request: body }, 'success');
      return reply.response;
    },

    close(): void {
      closed = true;
      failAll(new JanusUnavailableError('client closed'));
      socket?.close();
      socket = null;
    },
  };
}

export type JanusAdminClient = ReturnType<typeof createJanusAdminClient>;
