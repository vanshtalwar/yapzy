import { type z } from 'zod';

import { type ErrorCode } from '../errors.ts';
import { type ClientEventName, type ServerEventName } from './events.ts';
import type * as schemas from './schemas.ts';

// --- Acks ---------------------------------------------------------------------------------

export interface AckError {
  code: ErrorCode;
  message: string;
}

export type AckResponse<TData = undefined> =
  | (TData extends undefined ? { ok: true; data?: undefined } : { ok: true; data: TData })
  | { ok: false; error: AckError };

export type AckCallback<TData = undefined> = (response: AckResponse<TData>) => void;

// --- Payload types (inputs as the client sends them, outputs as the server emits them) -----

export type QueueJoinPayload = z.input<typeof schemas.queueJoinSchema>;
export type ChatMessagePayload = z.input<typeof schemas.chatMessageSchema>;
export type ChatTypingPayload = z.input<typeof schemas.chatTypingSchema>;
export type SessionRefPayload = z.input<typeof schemas.sessionRefSchema>;
export type RtcDescriptionPayload = z.input<typeof schemas.rtcDescriptionSchema>;
export type RtcIcePayload = z.input<typeof schemas.rtcIceSchema>;
export type RtcSummaryPayload = z.input<typeof schemas.rtcSummarySchema>;
export type ModerationSignalPayload = z.input<typeof schemas.moderationSignalSchema>;
export type SessionResumePayload = z.input<typeof schemas.sessionResumeSchema>;
export type EmptyPayload = Record<string, never>;

export type QueueWaiting = z.output<typeof schemas.queueWaitingSchema>;
export type MatchFound = z.output<typeof schemas.matchFoundSchema>;
export type PeerRole = z.output<typeof schemas.peerRoleSchema>;
export type ParticipantJoined = z.output<typeof schemas.participantJoinedSchema>;
export type ChatMessageOut = z.output<typeof schemas.chatMessageOutSchema>;
export type ChatTypingOut = z.output<typeof schemas.chatTypingOutSchema>;
export type RtcDescriptionOut = z.output<typeof schemas.rtcDescriptionOutSchema>;
export type RtcIceOut = z.output<typeof schemas.rtcIceOutSchema>;
export type PeerLeft = z.output<typeof schemas.peerLeftSchema>;
export type PeerPresence = z.output<typeof schemas.peerPresenceSchema>;
export type SessionResumed = z.output<typeof schemas.sessionResumedSchema>;
export type SystemNotice = z.output<typeof schemas.systemNoticeSchema>;
export type Pong = z.output<typeof schemas.pongSchema>;
/** Ack data for `chat:message`: the server-assigned id and timestamp of the stored message. */
export type ChatMessageAck = z.output<typeof schemas.chatMessageAckSchema>;
/** Normalized `queue:join` preferences, kept on the socket so `chat:next` can requeue. */
export type QueuePreferences = z.output<typeof schemas.queueJoinSchema>;

// --- Socket.io event maps -------------------------------------------------------------------

/** Every client event takes `(payload, ack)`; the server always answers the ack. */
export interface ClientToServerEvents {
  'queue:join': (payload: QueueJoinPayload, ack: AckCallback) => void;
  'queue:leave': (payload: EmptyPayload, ack: AckCallback) => void;
  'chat:next': (payload: SessionRefPayload, ack: AckCallback) => void;
  'chat:end': (payload: SessionRefPayload, ack: AckCallback) => void;
  'chat:message': (payload: ChatMessagePayload, ack: AckCallback<ChatMessageAck>) => void;
  'chat:typing': (payload: ChatTypingPayload, ack: AckCallback) => void;
  'rtc:offer': (payload: RtcDescriptionPayload, ack: AckCallback) => void;
  'rtc:answer': (payload: RtcDescriptionPayload, ack: AckCallback) => void;
  'rtc:ice': (payload: RtcIcePayload, ack: AckCallback) => void;
  'rtc:summary': (payload: RtcSummaryPayload, ack: AckCallback) => void;
  'moderation:signal': (payload: ModerationSignalPayload, ack: AckCallback) => void;
  'match:ack': (payload: SessionRefPayload, ack: AckCallback) => void;
  'session:resume': (payload: SessionResumePayload, ack: AckCallback<SessionResumed>) => void;
  ping: (payload: EmptyPayload, ack: AckCallback<Pong>) => void;
}

export interface ServerToClientEvents {
  'queue:waiting': (payload: QueueWaiting) => void;
  'match:found': (payload: MatchFound) => void;
  'participant:joined': (payload: ParticipantJoined) => void;
  'chat:message': (payload: ChatMessageOut) => void;
  'chat:typing': (payload: ChatTypingOut) => void;
  'rtc:offer': (payload: RtcDescriptionOut) => void;
  'rtc:answer': (payload: RtcDescriptionOut) => void;
  'rtc:ice': (payload: RtcIceOut) => void;
  'peer:reconnecting': (payload: PeerPresence) => void;
  'peer:resumed': (payload: PeerPresence) => void;
  'peer:left': (payload: PeerLeft) => void;
  'system:notice': (payload: SystemNotice) => void;
}

// Compile-time guard: the maps above and the name constants in events.ts must match exactly.
// A mismatch fails `tsc` here.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type SocketEventMapsMatch = [
  Assert<Exact<keyof ClientToServerEvents, ClientEventName>>,
  Assert<Exact<keyof ServerToClientEvents, ServerEventName>>,
];

export type VisitorState = 'idle' | 'waiting' | 'in_session';
export type MatchPool = 'normal' | 'shadow';

/** Server-side per-socket data (`socket.data`), set by the handshake middleware. */
export interface SocketData {
  visitorId: string;
  ipHash: string;
  pool: MatchPool;
  /** Last known state; authoritative state is derived from Redis on every event (D-038). */
  state: VisitorState;
  preferences: QueuePreferences | null;
}
