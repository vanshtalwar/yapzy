import { type Logger } from '@app/logger';
import { type AckError, type ClientEventName, ErrorCode, NOTICE_CODES } from '@app/shared';
import { type z } from 'zod';

import { SocketError } from './errors.ts';
import { type GatewayMetrics } from './metrics.ts';
import { TokenBucket } from './token-bucket.ts';
import { type GatewaySocket } from './types.ts';

export interface GuardOptions {
  /** false only when RATE_LIMIT_DISABLED=true in development. */
  rateLimitEnabled: boolean;
  /** Per-socket event budget: burst capacity and refill rate (tokens per second). */
  bucket: { capacity: number; refillPerSecond: number };
  /**
   * Strikes (rate-limited, invalid or unknown events) also drain a bucket; when it is empty the
   * socket is disconnected as abusive.
   */
  abuse: { capacity: number; refillPerSecond: number };
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  metrics: Pick<GatewayMetrics, 'events' | 'rateLimitHits' | 'abuseDisconnects'>;
}

interface SocketGuards {
  options: GuardOptions;
  events: TokenBucket;
  abuse: TokenBucket;
  registered: Set<string>;
  /** Resolves once the socket has joined its visitor room (see markSocketReady). */
  ready: Promise<void>;
}

const guardsBySocket = new WeakMap<GatewaySocket, SocketGuards>();

type Ack = (response: { ok: true; data?: unknown } | { ok: false; error: AckError }) => void;

/**
 * Raw socket args are untrusted: a client may send anything, in any shape, with or without ack —
 * even the event name can be any JSON value (socket.io-parser accepts numbers, null, objects).
 */
interface UntypedSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  onAny(listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

function splitArgs(args: unknown[]): { payload: unknown; ack: Ack | undefined } {
  const last = args.at(-1);
  if (typeof last === 'function') {
    return { payload: args.length > 1 ? args[0] : undefined, ack: last as Ack };
  }
  return { payload: args[0], ack: undefined };
}

/** Correlation id for error logs: most events carry the session they act on. */
function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) return;
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
}

function strike(socket: GatewaySocket, guards: SocketGuards, reason: string): void {
  if (guards.abuse.take(1)) return;
  guards.options.metrics.abuseDisconnects.inc();
  guards.options.logger.warn(
    { visitorId: socket.data.visitorId, socketId: socket.id, reason },
    'abusive socket disconnected',
  );
  socket.emit('system:notice', {
    code: NOTICE_CODES.RATE_LIMITED,
    message: 'Too many invalid or excessive requests',
  });
  socket.disconnect(true);
}

/**
 * Sets up per-socket guards (rate limiting, abuse detection, unknown-event handling). Must be
 * called once per socket before `registerHandler`.
 */
export function attachGuards(socket: GatewaySocket, options: GuardOptions): void {
  const guards: SocketGuards = {
    options,
    events: new TokenBucket(options.bucket.capacity, options.bucket.refillPerSecond),
    abuse: new TokenBucket(options.abuse.capacity, options.abuse.refillPerSecond),
    registered: new Set(),
    ready: Promise.resolve(),
  };
  guardsBySocket.set(socket, guards);

  // socket.io runs listeners in process.nextTick without a try/catch: anything thrown here
  // would be an uncaught exception that takes the whole node down.
  (socket as unknown as UntypedSocket).onAny((event, ...args) => {
    try {
      if (typeof event === 'string' && guards.registered.has(event)) return;
      const name = typeof event === 'string' ? event.slice(0, 64) : `<${typeof event}>`;
      options.logger.debug({ socketId: socket.id, event: name }, 'unknown event');
      options.metrics.events.inc({ event: 'unknown', outcome: 'invalid' });
      splitArgs(args).ack?.({
        ok: false,
        error: { code: ErrorCode.VALIDATION_FAILED, message: 'Unknown event' },
      });
      strike(socket, guards, 'unknown event');
    } catch (error) {
      options.logger.error({ err: error, socketId: socket.id }, 'unknown-event guard failed');
    }
  });
}

/**
 * Handlers wait for `ready` before running, so nothing a handler triggers (e.g. replies sent to
 * the visitor's room) can race the asynchronous room join after connect.
 */
export function markSocketReady(socket: GatewaySocket, ready: Promise<void>): void {
  const guards = guardsBySocket.get(socket);
  if (guards === undefined) throw new Error('attachGuards() must run before markSocketReady()');
  guards.ready = ready;
}

export interface HandlerContext {
  socket: GatewaySocket;
}

/**
 * Registers a validated, rate-limited handler. The ack (if the client sent one) is ALWAYS
 * answered with `{ ok: true, data? }` or `{ ok: false, error: { code, message } }`.
 */
export function registerHandler<TSchema extends z.ZodType, TResult>(
  socket: GatewaySocket,
  event: ClientEventName,
  schema: TSchema,
  handler: (payload: z.output<TSchema>, context: HandlerContext) => TResult | Promise<TResult>,
  { cost }: { cost: number },
): void {
  const guards = guardsBySocket.get(socket);
  if (guards === undefined) throw new Error('attachGuards() must run before registerHandler()');
  guards.registered.add(event);
  const { logger, rateLimitEnabled, metrics } = guards.options;
  const count = (outcome: string) => {
    metrics.events.inc({ event, outcome });
  };

  (socket as unknown as UntypedSocket).on(event, (...args) => {
    // Synchronous part guarded too: a throw here would be an uncaught exception (see onAny).
    try {
      const { payload, ack } = splitArgs(args);
      const fail = (code: ErrorCode, message: string) => {
        ack?.({ ok: false, error: { code, message } });
      };

      if (rateLimitEnabled && !guards.events.take(cost)) {
        count('rate_limited');
        metrics.rateLimitHits.inc({ route: event });
        fail(ErrorCode.RATE_LIMITED, 'Slow down');
        strike(socket, guards, `rate limited: ${event}`);
        return;
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        count('invalid');
        fail(ErrorCode.VALIDATION_FAILED, `Invalid payload for ${event}`);
        strike(socket, guards, `invalid payload: ${event}`);
        return;
      }

      void (async () => {
        try {
          await guards.ready;
          const data = await handler(parsed.data, { socket });
          count('ok');
          ack?.(data === undefined ? { ok: true } : { ok: true, data });
        } catch (error) {
          if (error instanceof SocketError) {
            count('error');
            fail(error.code, error.message);
            return;
          }
          count('internal_error');
          const sessionId = sessionIdOf(parsed.data);
          logger.error(
            {
              err: error,
              event,
              visitorId: socket.data.visitorId,
              socketId: socket.id,
              ...(sessionId === undefined ? {} : { sessionId }),
            },
            'socket handler failed',
          );
          fail(ErrorCode.INTERNAL_ERROR, 'Internal error');
        }
      })();
    } catch (error) {
      logger.error({ err: error, event, socketId: socket.id }, 'socket guard failed');
    }
  });
}
