/** Session keys stay this long after a session ends so reports can still reference it. */
export const SESSION_ENDED_TTL_SECONDS = 60 * 60;

/** Gateway node presence expires unless refreshed (nodes refresh well within this window). */
export const PRESENCE_TTL_SECONDS = 15;

/** Per-minute match counters are kept for live stats over the last 2 hours. */
export const STATS_MATCHES_TTL_SECONDS = 2 * 60 * 60;

/** Size of the per-session transcript ring buffer (`session:{id}:log`). */
export const TRANSCRIPT_MAX_MESSAGES = 100;
