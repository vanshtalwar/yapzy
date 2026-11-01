import { z } from 'zod';

/** cjson turns an empty Lua table into `{}`; tickets re-encoded by a script need this. */
const interestList = z.preprocess(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
      ? []
      : value,
  z.array(z.string()),
);

export const TICKET_STATUSES = ['waiting', 'matched', 'cancelled'] as const;

export const ticketSchema = z.object({
  ticketId: z.uuid(),
  visitorId: z.string().min(1),
  interests: interestList,
  /** Epoch ms. */
  createdAt: z.number().int(),
  status: z.enum(TICKET_STATUSES),
  /** Which queues the ticket sits in: its interest queues, or (after promotion) `q:any`. */
  phase: z.enum(['interest', 'any']),
  /** Requeue automatically (with priority) if a session fails early (D-048). */
  autoRequeue: z.boolean().default(false),
  /**
   * May join a group call (Part 12): opted in (`allowGroup`), video, normal pool and trusted
   * enough — decided by the gateway when the ticket is created.
   */
  group: z.boolean().default(false),
  /** Gateway node that owns the waiting socket; lets the sweeper drop tickets of dead nodes. */
  nodeId: z.string().optional(),
  /** Set by the script when the ticket is matched. */
  sessionId: z.string().optional(),
});

export type Ticket = z.output<typeof ticketSchema>;

export type NewTicket = Pick<Ticket, 'ticketId' | 'visitorId' | 'interests' | 'createdAt'> & {
  autoRequeue?: boolean;
  group?: boolean;
  nodeId?: string;
};

export const SEEK_STATUSES = ['seeking', 'filled', 'cancelled'] as const;

/** A session looking for one more person, in one bucket of its family (Part 12). */
export const seekSchema = z.object({
  sessionId: z.uuid(),
  /** One search round of the session (a new round = new id). */
  seekId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  /** Everyone in the call now: a joiner must not be one of them nor a recent pair of any. */
  visitorIds: z.array(z.string().min(1)).min(1),
  createdAt: z.number().int(),
  status: z.enum(SEEK_STATUSES),
  /** Visitor id of the ticket that filled the seek. */
  joiner: z.string().optional(),
});

export type Seek = z.output<typeof seekSchema>;
