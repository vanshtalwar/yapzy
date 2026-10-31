import { type ErrorCode } from '@app/shared';

/** Expected failure inside a handler; becomes `{ ok: false, error: { code, message } }`. */
export class SocketError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}

/**
 * Rejection from the handshake middleware. Socket.io sends `message` and `data` to the client
 * as a `connect_error`.
 */
export class HandshakeError extends Error {
  readonly data: { code: ErrorCode; message: string } & Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HandshakeError';
    this.data = { ...details, code, message };
  }
}
