import {
  ErrorCode,
  errorEnvelopeSchema,
  onlineStatsSchema,
  type PublicConfig,
  publicConfigSchema,
  type ReportFields,
  reportResponseSchema,
  type SessionRequest,
  type SessionResponse,
  sessionResponseSchema,
  type TurnCredentials,
  turnCredentialsSchema,
} from '@app/shared';
import { type z } from 'zod';

import { publicConfig } from './config.ts';
import { type UploadResult } from './moderation/frame-sampler.ts';

/** A failed API call, with the server's error code (or SERVICE_UNAVAILABLE for network). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.output<TSchema>> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    response = await fetch(`${publicConfig.apiUrl}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      ErrorCode.SERVICE_UNAVAILABLE,
      'Cannot reach the server. Check your connection.',
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    if (envelope.success) {
      const { code, message, ...details } = envelope.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(response.status, ErrorCode.INTERNAL_ERROR, 'Unexpected server response');
  }
  return schema.parse(body);
}

export const api = {
  getConfig: (): Promise<PublicConfig> => request('/v1/config', publicConfigSchema),

  getOnlineCount: async (): Promise<number> =>
    (await request('/v1/stats/online', onlineStatsSchema)).online,

  createSession: (body: SessionRequest): Promise<SessionResponse> =>
    request('/v1/session', sessionResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getTurnCredentials: (token: string): Promise<TurnCredentials> =>
    request('/v1/turn-credentials', turnCredentialsSchema, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Multipart: fields + the stranger's last frames (JPEG) kept in memory for evidence. */
  report: async (token: string, fields: ReportFields, frames: Blob[]): Promise<string> => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    frames.forEach((frame, index) => {
      form.append('frames', frame, `frame-${String(index + 1)}.jpg`);
    });
    const { reportId } = await request('/v1/reports', reportResponseSchema, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return reportId;
  },

  /** One moderation frame of the own video, at the server-assigned interval (D-054). */
  uploadFrame: async (token: string, sessionId: string, frame: Blob): Promise<UploadResult> => {
    let response: Response;
    try {
      response = await fetch(
        `${publicConfig.apiUrl}/v1/moderation/frames?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
          body: frame,
        },
      );
    } catch {
      return 'skip';
    }
    if (response.ok) return 'ok';
    // 403: no (more) frames expected in this session; 429: too early or none left.
    if (response.status === 403) return 'stop';
    if (response.status === 429) {
      const body: unknown = await response.json().catch(() => null);
      const envelope = errorEnvelopeSchema.safeParse(body);
      return envelope.success && envelope.data.error.message.startsWith('No more')
        ? 'stop'
        : 'skip';
    }
    return 'skip';
  },
};
