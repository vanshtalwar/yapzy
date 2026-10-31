import { createLogger, type Logger } from './create-logger.ts';

export interface CapturedLogs {
  logger: Logger;
  /** Every JSON log line written so far. */
  lines: string[];
  text(): string;
}

/** A trace-level logger that keeps every line in memory (log-privacy tests). */
export function createCapturingLogger(service: string): CapturedLogs {
  const lines: string[] = [];
  const logger = createLogger({
    service,
    level: 'trace',
    nodeEnv: 'test',
    destination: {
      write(line: string) {
        lines.push(line);
      },
    },
  });
  return { logger, lines, text: () => lines.join('') };
}

/** Anything shaped like a JWT (header.payload.signature, base64url, JSON header). */
const JWT_PATTERN = /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/;

/**
 * The secrets (and JWT-shaped strings) found in `text`. A log-privacy test passes when this is
 * empty; it returns the labels only, so a failing test never prints the secret itself.
 */
export function findSecrets(text: string, secrets: Record<string, string>): string[] {
  const found = Object.entries(secrets)
    .filter(([, secret]) => secret !== '' && text.includes(secret))
    .map(([label]) => label);
  if (JWT_PATTERN.test(text)) found.push('jwt-shaped string');
  return found;
}
