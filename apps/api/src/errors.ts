import { type ErrorCode } from '@app/shared';

/**
 * Expected, client-facing failure. The error handler turns it into
 * `{ error: { code, message, requestId, ...details } }`; anything else becomes a generic 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; requestId: string } & Record<string, unknown>;
}
