import { ErrorCode } from '@app/shared';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { AppError, type ErrorEnvelope } from '../errors.ts';

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
) {
  const body: ErrorEnvelope = { error: { ...details, code, message, requestId: request.id } };
  return reply.status(statusCode).send(body);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/** One error envelope for every failure: `{ error: { code, message, requestId } }`. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return send(request, reply, error.statusCode, error.code, error.message, error.details);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message,
      }));
      return send(request, reply, 400, ErrorCode.VALIDATION_FAILED, 'Invalid request', { issues });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its schema');
      return send(request, reply, 500, ErrorCode.INTERNAL_ERROR, 'Internal server error');
    }

    // Fastify's own 4xx errors (malformed JSON, oversized body, wrong content type, ...).
    const statusCode = statusOf(error);
    if (statusCode === 413) {
      return send(request, reply, 413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body too large');
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : 'Bad request';
      return send(request, reply, statusCode, ErrorCode.VALIDATION_FAILED, message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(request, reply, 500, ErrorCode.INTERNAL_ERROR, 'Internal server error');
  });

  app.setNotFoundHandler((request, reply) =>
    send(request, reply, 404, ErrorCode.NOT_FOUND, 'Route not found'),
  );
}
