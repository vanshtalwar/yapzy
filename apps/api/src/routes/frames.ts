import { type ApiEnv } from '@app/env';
import { MOD_FRAMES_WINDOW_SECONDS, moderationFramesKey, type Redis } from '@app/redis';
import {
  ErrorCode,
  frameQuerySchema,
  frameUploadResponseSchema,
  MODERATION_FRAME_MAX_BYTES,
  MODERATION_FRAME_MAX_PX,
} from '@app/shared';
import { type ObjectStore } from '@app/storage';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { type Clock } from '../deps.ts';
import { AppError } from '../errors.ts';
import { InvalidImageError, jpegSize } from '../services/images.ts';
import { type ApiJobs } from '../services/jobs.ts';
import { type SessionState } from '../services/session-state.ts';

/** Clients jitter uploads by ±20 % (D-054); anything faster than 80 % is refused. */
export const FRAME_MIN_GAP_RATIO = 0.8;
/** Coarse per-visitor cap on top of the per-session schedule. */
export const FRAME_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

interface FrameDeps {
  config: ApiEnv;
  redis: Redis;
  objects: ObjectStore;
  jobs: ApiJobs;
  sessions: SessionState;
  clock: Clock;
}

/**
 * `POST /v1/moderation/frames?sessionId=…` (`image/jpeg`, ≤ 60 KB, ≤ 320 px): one frame of
 * the visitor's OWN outgoing video, only at the interval the gateway assigned to them in
 * this session. Stored in the frames bucket (1-day lifecycle) and classified by the worker.
 */
export const frameRoutes: FastifyPluginAsyncZod<FrameDeps> = (app, deps) => {
  const { config, redis, objects, jobs, sessions, clock } = deps;
  app.addContentTypeParser(
    'image/jpeg',
    { parseAs: 'buffer', bodyLimit: MODERATION_FRAME_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    '/v1/moderation/frames',
    {
      onRequest: [app.authenticate],
      bodyLimit: MODERATION_FRAME_MAX_BYTES,
      schema: { querystring: frameQuerySchema, response: { 202: frameUploadResponseSchema } },
      config: {
        rateLimit: {
          ...FRAME_RATE_LIMIT,
          hook: 'preHandler',
          keyGenerator: (request) => request.visitor?.id ?? 'anonymous',
        },
      },
    },
    async (request, reply) => {
      const visitor = request.visitor;
      if (visitor === null) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing bearer token');
      const { sessionId } = request.query;
      const body = request.body;
      if (!(body instanceof Buffer)) {
        throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Expected an image/jpeg body');
      }

      const current = await sessions.currentSession(visitor.id);
      const [meta, participants] = await Promise.all([
        sessions.meta(sessionId),
        sessions.participants(sessionId),
      ]);
      const self =
        current?.sessionId === sessionId ? participants.get(current.participantId) : undefined;
      if (
        current === null ||
        self === undefined ||
        self.status === 'left' ||
        meta.mode !== 'video' ||
        meta.state !== 'active' ||
        self.frameIntervalMs == null
      ) {
        throw new AppError(
          403,
          ErrorCode.FORBIDDEN,
          'No frames are expected from you in this session',
        );
      }

      try {
        const { width, height } = await jpegSize(body);
        if (width > MODERATION_FRAME_MAX_PX || height > MODERATION_FRAME_MAX_PX) {
          throw new InvalidImageError(
            `Frames must be at most ${String(MODERATION_FRAME_MAX_PX)} px`,
          );
        }
      } catch (error) {
        if (error instanceof InvalidImageError) {
          throw new AppError(400, ErrorCode.VALIDATION_FAILED, error.message);
        }
        throw error;
      }

      const now = clock.now();
      const verdict = await sessions.acceptFrame({
        sessionId,
        participantId: current.participantId,
        now: now.getTime(),
        minGapMs: Math.round(self.frameIntervalMs * FRAME_MIN_GAP_RATIO),
        maxFrames: self.maxFrames ?? null,
      });
      if (verdict !== 'ok') {
        throw new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          verdict === 'limit' ? 'No more frames are expected' : 'Frame sent too early',
        );
      }

      const storageKey = `${sessionId}/${current.participantId}/${String(now.getTime())}.jpg`;
      await objects.put(config.S3_BUCKET_FRAMES, storageKey, body, 'image/jpeg');
      const window =
        Math.floor(now.getTime() / 1000 / MOD_FRAMES_WINDOW_SECONDS) * MOD_FRAMES_WINDOW_SECONDS;
      await redis
        .multi()
        .incr(moderationFramesKey(window))
        .expire(moderationFramesKey(window), 120)
        .exec();
      await jobs.classifyFrame({
        storageKey,
        sessionId,
        participantId: current.participantId,
        visitorId: visitor.id,
        receivedAt: now.toISOString(),
      });
      return reply.status(202).send({ accepted: true });
    },
  );
  return Promise.resolve();
};
