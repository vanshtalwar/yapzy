export const MAX_MESSAGE_LENGTH = 500;
export const MAX_INTERESTS = 5;
export const MAX_INTEREST_LENGTH = 24;

/** Most people in one call (Part 12); 2-person calls stay P2P until a group is formed. */
export const MAX_GROUP_PARTICIPANTS = 4;
/** Everyone must answer "add a person?" within this long (Part 12). */
export const ADD_REQUEST_TTL_MS = 15_000;

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
