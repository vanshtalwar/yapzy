import { type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type Logger } from '@app/logger';
import { type Redis } from '@app/redis';

import { type TurnstileVerifier } from './services/turnstile.ts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Everything the app touches from outside; injected so tests can swap any of it. */
export interface AppDeps {
  config: ApiEnv;
  prisma: PrismaClient;
  redis: Redis;
  turnstile: TurnstileVerifier;
  clock?: Clock;
  logger?: Logger;
}
