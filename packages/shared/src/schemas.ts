import { z } from 'zod';

import {
  CHAT_MODES,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS,
  MAX_MESSAGE_LENGTH,
  SUPPORTED_LANGS,
} from './constants.ts';
import { ErrorCode } from './errors.ts';

export const chatModeSchema = z.enum(CHAT_MODES);
export const langSchema = z.enum(SUPPORTED_LANGS);

/** One interest tag, normalized so "Music " and "music" land in the same queue. */
export const interestSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(MAX_INTEREST_LENGTH)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Use letters, numbers, spaces, - or _');

export const interestsSchema = z
  .array(interestSchema)
  .max(MAX_INTERESTS)
  .transform((interests) => [...new Set(interests)]);

export const messageTextSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const errorCodeSchema = z.enum(ErrorCode);
