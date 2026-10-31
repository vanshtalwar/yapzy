export const MAX_MESSAGE_LENGTH = 500;
export const MAX_INTERESTS = 5;
export const MAX_INTEREST_LENGTH = 24;

export const CHAT_MODES = ['text', 'video'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** ISO 639-1 codes; each language has its own matchmaking queues. */
export const SUPPORTED_LANGS = [
  'en',
  'es',
  'pt',
  'fr',
  'de',
  'it',
  'nl',
  'pl',
  'tr',
  'ru',
  'ar',
  'hi',
  'id',
  'ja',
  'ko',
  'zh',
] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: SupportedLang = 'en';
