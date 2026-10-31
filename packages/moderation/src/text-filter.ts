import {
  asteriskCensorStrategy,
  englishDataset,
  type EnglishProfaneWord,
  englishRecommendedTransformers,
  RegExpMatcher,
  TextCensor,
} from 'obscenity';

export type TextFilterReason =
  'link' | 'email' | 'phone' | 'handle' | 'hate' | 'abuse' | 'blocked_term' | 'profanity';

export interface TextFilterResult {
  action: 'allow' | 'mask' | 'block';
  reasons: TextFilterReason[];
  /** Text to relay when `action` is `mask` (profanity replaced by asterisks). */
  masked?: string;
}

export interface TextFilterOptions {
  /** Block URLs and domain names, incl. obfuscated ones ("x dot com", "w w w . x . c o m"). */
  blockLinks?: boolean;
  /** Block emails, phone numbers and requests to move to another app/handle. */
  blockContacts?: boolean;
  /** Domains that may be shared (e.g. your own help center). */
  allowedDomains?: string[];
  /** Extra phrases that always block (case-insensitive, matched on word boundaries). */
  extraBlockedTerms?: string[];
  /** Replace profanity with asterisks instead of relaying it unchanged. */
  maskProfanity?: boolean;
}

/** Slurs from the obscenity dataset that block the message instead of masking it. */
const HATE_WORDS = new Set<EnglishProfaneWord>([
  'abeed',
  'abo',
  'africoon',
  'arabush',
  'boonga',
  'chingchong',
  'chink',
  'fag',
  'kike',
  'nigger',
  'tranny',
]);

/** Encouraging self-harm is never acceptable, whatever the wording around it. */
const ABUSE_PHRASES = ['kill yourself', 'kill urself', 'kys', 'go die', 'neck yourself'];

/** TLDs worth catching in chat (generic ones, popular ccTLDs and link-shortener favourites). */
const TLDS = [
  'com',
  'net',
  'org',
  'io',
  'me',
  'gg',
  'co',
  'app',
  'dev',
  'xyz',
  'ly',
  'tv',
  'ru',
  'de',
  'uk',
  'in',
  'info',
  'biz',
  'link',
  'site',
  'online',
  'live',
  'club',
  'top',
  'to',
  'cc',
  'us',
  'ca',
  'au',
  'fr',
  'jp',
  'cn',
  'br',
  'es',
  'it',
  'nl',
  'pl',
  'se',
  'ch',
  'be',
  'at',
  'dk',
  'fi',
  'no',
  'cz',
  'gr',
  'tr',
  'mx',
  'ar',
  'kr',
  'tw',
  'hk',
  'sg',
  'id',
  'ph',
  'vn',
  'th',
  'za',
  'ng',
  'ae',
  'il',
  'pk',
  'nz',
  'ie',
  'pt',
  'ro',
  'ua',
  'ws',
  'fm',
  'am',
  'sh',
  'ai',
  'page',
  'chat',
  'fun',
  'store',
  'shop',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'onion',
  'eu',
  'pro',
  'cam',
  'sex',
  'porn',
  'xxx',
  'adult',
  'dating',
  'video',
  'click',
  'icu',
  'su',
  'lol',
  'wtf',
] as const;

const PLATFORMS =
  '(?:snap(?:chat)?|sc|insta(?:gram)?|ig|tik\\s?tok|telegram|tg|kik|discord|whats\\s?app|wa|wechat|line|signal|twitter|fb|facebook|messenger|onlyfans|skype|reddit|twitch|threads|viber)';

const PATTERNS = {
  scheme: /\b(?:h\s*t\s*t\s*p\s*s?|hxxps?)\s*:\s*\/\s*\//i,
  www: /\bw\s*w\s*w\s*\./i,
  domain: new RegExp(`\\b[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63})*\\.(?:${TLDS.join('|')})\\b`, 'i'),
  email:
    /[a-z0-9._%+-]+\s*(?:@|\(\s*at\s*\)|\[\s*at\s*\])\s*[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i,
  spelledEmail:
    /[a-z0-9._-]{2,}\s+at\s+(?:gmail|g\s*mail|yahoo|hotmail|outlook|icloud|proton(?:mail)?|aol|gmx|yandex|live|msn)\b/i,
  phoneish: /\+?\(?\d[\d\s().\-–]{6,}\d/g,
  addMe: new RegExp(
    `\\b(?:add|follow|dm|msg|message|text|hit|hmu|find|contact)\\s+(?:me\\s+|up\\s+)?(?:on|at|in|via|@)\\s+${PLATFORMS}\\b`,
    'i',
  ),
  platformHandle: new RegExp(
    `\\b(?:my\\s+)?${PLATFORMS}\\s*(?:(?:id|handle|username|user|name|acc(?:ount)?)\\s*)?(?:is|=|:|-|>)\\s*@?[a-z0-9._-]{2,}`,
    'i',
  ),
  atHandle: /(?:^|[\s(])@[a-z0-9_.]{3,30}\b/i,
  discordTag: /\b[a-z0-9_.]{2,32}#\d{4}\b/i,
} as const;

/** Collapses obfuscation tricks so the detectors see a plain address. */
function deobfuscate(text: string): string {
  return (
    text
      .toLowerCase()
      // "x (dot) com", "x [.] com", "x dot com" → "x.com"
      .replace(/\s*[([{]\s*(?:dot|\.)\s*[)\]}]\s*/g, '.')
      .replace(/\s+dot\s+/g, '.')
      // "x . com" / "x .com" (but not a sentence end like "ok. me too")
      .replace(/\s+\.\s*(?=[a-z0-9])/g, '.')
      // "w w w . x . c o m": single characters separated by single spaces → one token
      .replace(/\b(?:[a-z0-9.]\s){2,}[a-z0-9.]\b/g, (run) => run.replace(/\s/g, ''))
  );
}

function hasPhoneNumber(text: string): boolean {
  for (const match of text.matchAll(PATTERNS.phoneish)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) return true;
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseMatcher(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternatives = cleaned.map((phrase) => escapeRegExp(phrase).replace(/\s+/g, '\\s+'));
  return new RegExp(`\\b(?:${alternatives.join('|')})\\b`, 'i');
}

/**
 * Chat text filter (runs on the gateway before relaying). Links and contact details are
 * blocked by default (the classic way strangers move victims off-platform), hate slurs and
 * self-harm encouragement are blocked, other profanity is masked.
 */
export function createTextFilter(options: TextFilterOptions = {}) {
  const {
    blockLinks = true,
    blockContacts = true,
    allowedDomains = [],
    extraBlockedTerms = [],
    maskProfanity = true,
  } = options;
  const matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });
  const censor = new TextCensor().setStrategy(asteriskCensorStrategy());
  const abuse = phraseMatcher(ABUSE_PHRASES);
  const blockedTerms = phraseMatcher(extraBlockedTerms);
  const allowed = allowedDomains.map((domain) => domain.toLowerCase());

  const linkFound = (plain: string): boolean => {
    if (PATTERNS.scheme.test(plain) || PATTERNS.www.test(plain)) return true;
    const domains = plain.match(new RegExp(PATTERNS.domain.source, 'gi')) ?? [];
    return domains.some(
      (domain) => !allowed.some((ok) => domain === ok || domain.endsWith(`.${ok}`)),
    );
  };

  return function textFilter(text: string): TextFilterResult {
    const reasons = new Set<TextFilterReason>();
    const plain = deobfuscate(text);

    if (blockLinks && linkFound(plain)) reasons.add('link');
    if (blockContacts) {
      if (PATTERNS.email.test(plain) || PATTERNS.spelledEmail.test(plain)) reasons.add('email');
      if (hasPhoneNumber(text)) reasons.add('phone');
      if (
        PATTERNS.addMe.test(plain) ||
        PATTERNS.platformHandle.test(plain) ||
        PATTERNS.atHandle.test(text) ||
        PATTERNS.discordTag.test(text)
      ) {
        reasons.add('handle');
      }
    }
    if (abuse?.test(plain) === true) reasons.add('abuse');
    if (blockedTerms?.test(plain) === true) reasons.add('blocked_term');

    const matches = matcher.getAllMatches(text, true);
    for (const match of matches) {
      const word = englishDataset.getPayloadWithPhraseMetadata(match).phraseMetadata?.originalWord;
      if (word !== undefined && HATE_WORDS.has(word)) reasons.add('hate');
    }

    if (reasons.size > 0) return { action: 'block', reasons: [...reasons] };
    if (matches.length > 0 && maskProfanity) {
      return { action: 'mask', reasons: ['profanity'], masked: censor.applyTo(text, matches) };
    }
    return { action: 'allow', reasons: [] };
  };
}

export type TextFilter = ReturnType<typeof createTextFilter>;
