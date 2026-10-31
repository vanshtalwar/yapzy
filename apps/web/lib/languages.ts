import { SUPPORTED_LANGS, type SupportedLang } from '@app/shared';

/** Native names, so people can find their own language. */
export const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  tr: 'Türkçe',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
} as const satisfies Record<SupportedLang, string>;

export const LANGUAGE_OPTIONS = SUPPORTED_LANGS.map((code) => ({
  code,
  name: LANGUAGE_NAMES[code],
}));
