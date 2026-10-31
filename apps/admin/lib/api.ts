import { ADMIN_CSRF_HEADER, ErrorCode, errorEnvelopeSchema } from '@app/shared';
import { z } from 'zod';

const apiUrl = z.url().parse(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** CSRF token of the current session (from login / me); sent on every POST. */
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when the API answers 401 (session expired or revoked). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T extends z.ZodType>(
  method: 'GET' | 'POST',
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.output<T>> {
  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method === 'POST' && csrfToken !== null) headers.set(ADMIN_CSRF_HEADER, csrfToken);
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/admin${path}`, {
      method,
      headers,
      credentials: 'include', // httpOnly session cookie
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, ErrorCode.SERVICE_UNAVAILABLE, 'Cannot reach the API');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(payload);
    const error = envelope.success
      ? new ApiError(response.status, envelope.data.error.code, envelope.data.error.message)
      : new ApiError(response.status, ErrorCode.INTERNAL_ERROR, 'Unexpected response');
    if (response.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw error;
  }
  return schema.parse(payload);
}

export const api = {
  get: <T extends z.ZodType>(path: string, schema: T) => request('GET', path, schema),
  post: <T extends z.ZodType>(path: string, schema: T, body?: unknown) =>
    request('POST', path, schema, body ?? {}),
};

/** Query string from defined values only. */
export function query(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}
