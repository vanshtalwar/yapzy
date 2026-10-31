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
  /** Gateway node that owns the waiting socket; lets the sweeper drop tickets of dead nodes. */
  nodeId: z.string().optional(),
  /** Set by the script when the ticket is matched. */
  sessionId: z.string().optional(),
});

export type Ticket = z.output<typeof ticketSchema>;

export type NewTicket = Pick<Ticket, 'ticketId' | 'visitorId' | 'interests' | 'createdAt'> & {
  nodeId?: string;
};
