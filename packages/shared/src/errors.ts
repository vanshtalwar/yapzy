/**
 * Error codes shared by REST responses, socket acks and `system:notice`.
 * A const object (not a TS enum) so it works under erasable-syntax-only TypeScript.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  BANNED: 'BANNED',
  TURNSTILE_FAILED: 'TURNSTILE_FAILED',
  AGE_NOT_CONFIRMED: 'AGE_NOT_CONFIRMED',
  TOS_OUTDATED: 'TOS_OUTDATED',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  INVALID_STATE: 'INVALID_STATE',
  NOT_IN_SESSION: 'NOT_IN_SESSION',
  SESSION_NOT_RESUMABLE: 'SESSION_NOT_RESUMABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_REPLACED: 'SESSION_REPLACED',
  MESSAGE_BLOCKED: 'MESSAGE_BLOCKED',
  SERVER_RESTARTING: 'SERVER_RESTARTING',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Admin authentication (Part 9)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOTP_REQUIRED: 'TOTP_REQUIRED',
  TOTP_INVALID: 'TOTP_INVALID',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  CSRF_FAILED: 'CSRF_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode);

/** Wire shape of an error in REST bodies and socket acks. */
export interface AppErrorBody {
  code: ErrorCode;
  message: string;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
