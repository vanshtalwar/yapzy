/** Client → server event names (single source of truth; never use string literals elsewhere). */
export const CLIENT_EVENTS = {
  QUEUE_JOIN: 'queue:join',
  QUEUE_LEAVE: 'queue:leave',
  CHAT_NEXT: 'chat:next',
  CHAT_END: 'chat:end',
  CHAT_MESSAGE: 'chat:message',
  CHAT_TYPING: 'chat:typing',
  RTC_OFFER: 'rtc:offer',
  RTC_ANSWER: 'rtc:answer',
  RTC_ICE: 'rtc:ice',
  RTC_SUMMARY: 'rtc:summary',
  MODERATION_SIGNAL: 'moderation:signal',
  PING: 'ping',
} as const;

export type ClientEventName = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

/** Server → client event names. */
export const SERVER_EVENTS = {
  QUEUE_WAITING: 'queue:waiting',
  MATCH_FOUND: 'match:found',
  PARTICIPANT_JOINED: 'participant:joined',
  CHAT_MESSAGE: 'chat:message',
  CHAT_TYPING: 'chat:typing',
  RTC_OFFER: 'rtc:offer',
  RTC_ANSWER: 'rtc:answer',
  RTC_ICE: 'rtc:ice',
  PEER_LEFT: 'peer:left',
  SYSTEM_NOTICE: 'system:notice',
} as const;

export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/** Codes carried by `system:notice` (a subset of ErrorCode plus lifecycle notices). */
export const NOTICE_CODES = {
  SESSION_REPLACED: 'SESSION_REPLACED',
  SERVER_RESTARTING: 'SERVER_RESTARTING',
  BANNED: 'BANNED',
  MESSAGE_BLOCKED: 'MESSAGE_BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type NoticeCode = (typeof NOTICE_CODES)[keyof typeof NOTICE_CODES];
