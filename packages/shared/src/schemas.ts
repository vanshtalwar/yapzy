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

/**
 * One interest tag, normalized so "Indie Games", "indie_games" and " INDIE-games!" all land in
 * the same queue ("indie-games"): trim, lowercase, whitespace/underscores → "-", strip every
 * other non-alphanumeric (Unicode letters/digits are kept), collapse and trim dashes.
 */
export const interestSchema = z
  .string()
  .max(MAX_INTEREST_LENGTH * 4)
  .transform((raw) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, ''),
  )
  .pipe(z.string().min(1).max(MAX_INTEREST_LENGTH));

export const interestsSchema = z
  .array(interestSchema)
  .max(MAX_INTERESTS)
  .transform((interests) => [...new Set(interests)]);

export const messageTextSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const errorCodeSchema = z.enum(ErrorCode);
