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
  MATCH_ACK: 'match:ack',
  SESSION_RESUME: 'session:resume',
  PING: 'ping',
  /** The client receives every peer through the new topology and closed the old one (Part 11). */
  CALL_TOPOLOGY_READY: 'call:topologyReady',
  /** A fresh Janus token for API requests during a long call (signed tokens expire, D-120). */
  CALL_SFU_TOKEN: 'call:sfuToken',
  /** Development only: switch a running P2P call to Janus. */
  DEV_UPGRADE_TO_SFU: 'dev:upgradeToSfu',
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
  PEER_RECONNECTING: 'peer:reconnecting',
  PEER_RESUMED: 'peer:resumed',
  PEER_LEFT: 'peer:left',
  SYSTEM_NOTICE: 'system:notice',
  /** Switch to (or, on failover, move within) Janus — or roll a failed switch back (Part 11). */
  CALL_TOPOLOGY: 'call:topology',
} as const;

export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/** Codes carried by `system:notice` (a subset of ErrorCode plus lifecycle notices). */
export const NOTICE_CODES = {
  SESSION_REPLACED: 'SESSION_REPLACED',
  SERVER_RESTARTING: 'SERVER_RESTARTING',
  BANNED: 'BANNED',
  MESSAGE_BLOCKED: 'MESSAGE_BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  /** The server changed this participant's frame-sampling schedule (D-054). */
  FRAME_SCHEDULE: 'FRAME_SCHEDULE',
} as const;

export type NoticeCode = (typeof NOTICE_CODES)[keyof typeof NOTICE_CODES];
