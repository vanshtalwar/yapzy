import { type DestinationStream, type LevelWithSilent, type Logger, pino } from 'pino';
import pretty from 'pino-pretty';

const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  '["set-cookie"]',
  '["x-forwarded-for"]',
  '["x-real-ip"]',
  '["x-admin-csrf"]',
];

/**
 * Paths censored in every log line. Wildcards cover one nesting level (e.g. `req.token`).
 * Headers are censored under any parent (`req.headers`, `res.headers`, and plugin options such
 * as @fastify/multipart's trace log of `busboyOptions.headers`), since they sit two levels deep.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'token',
  'password',
  'ip',
  'deviceId',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.password',
  '*.ip',
  '*.deviceId',
  ...SENSITIVE_HEADERS.map((header) => `headers${header.startsWith('[') ? '' : '.'}${header}`),
  ...SENSITIVE_HEADERS.map((header) => `*.headers${header.startsWith('[') ? '' : '.'}${header}`),
  'req.remoteAddress',
  'req.remotePort',
];

export interface CreateLoggerOptions {
  service: string;
  level?: LevelWithSilent;
  /** Pretty, colorized output only in development; JSON lines everywhere else. */
  nodeEnv?: 'development' | 'test' | 'production';
  /** Override the output stream (tests, custom transports). */
  destination?: DestinationStream;
}

export function createLogger({
  service,
  level = 'info',
  nodeEnv = 'production',
  destination,
}: CreateLoggerOptions): Logger {
  // pino-pretty as an in-process stream (not a worker transport) keeps bundling simple.
  const stream =
    destination ??
    (nodeEnv === 'development'
      ? pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' })
      : undefined);

  const options = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };

  return stream === undefined ? pino(options) : pino(options, stream);
}

export type { Logger } from 'pino';
