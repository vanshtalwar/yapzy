/**
 * Error codes shared by REST responses, socket acks and `system:notice`.
 * A const object (not a TS enum) so it works under erasable-syntax-only TypeScript.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  BANNED: 'BANNED',
  TURNSTILE_FAILED: 'TURNSTILE_FAILED',
  AGE_NOT_CONFIRMED: 'AGE_NOT_CONFIRMED',
  TOS_OUTDATED: 'TOS_OUTDATED',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  NOT_IN_SESSION: 'NOT_IN_SESSION',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_REPLACED: 'SESSION_REPLACED',
  MESSAGE_BLOCKED: 'MESSAGE_BLOCKED',
  SERVER_RESTARTING: 'SERVER_RESTARTING',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
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
