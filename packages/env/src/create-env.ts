import { type z } from 'zod';

import { loadRootEnvFile } from './load-env-file.ts';

export type EnvSource = Record<string, string | undefined>;

export interface CreateEnvOptions {
  /** Used in error messages, e.g. "api". */
  service?: string;
  /** Variables to validate instead of `process.env` (skips loading the root .env). */
  source?: EnvSource;
}

export interface EnvIssue {
  variable: string;
  problem: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[], service?: string) {
    const target = service === undefined ? '' : ` for "${service}"`;
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.problem}`);
    super(
      [
        `Invalid environment configuration${target}:`,
        ...lines,
        'Fix the root .env file (see .env.example) or the process environment.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

// Messages intentionally never include the received value: env vars hold secrets.
function toEnvIssue(issue: z.core.$ZodIssue, source: EnvSource): EnvIssue {
  const variable = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
  const topKey = issue.path[0];
  const isMissing = typeof topKey === 'string' && source[topKey] === undefined;
  return { variable, problem: isMissing ? 'missing (required)' : issue.message };
}

/**
 * Validates environment variables against a Zod schema and returns the typed result.
 * Throws an EnvValidationError listing every missing/invalid variable at once.
 */
export function createEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  options: CreateEnvOptions = {},
): z.output<TSchema> {
  let source = options.source;
  if (source === undefined) {
    loadRootEnvFile();
    source = process.env;
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => toEnvIssue(issue, source));
    throw new EnvValidationError(issues, options.service);
  }
  return result.data;
}
