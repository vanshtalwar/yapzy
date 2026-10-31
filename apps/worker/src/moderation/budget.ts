import { nextBudgetMultiplier } from '@app/moderation';
import {
  MOD_BUDGET_MULTIPLIER_KEY,
  MOD_FRAMES_WINDOW_SECONDS,
  moderationFramesKey,
  type Redis,
} from '@app/redis';

/** The multiplier expires if no worker refreshes it, so gateways fall back to 1 (no stretch). */
const MULTIPLIER_TTL_SECONDS = 60;

/**
 * Global frame budget (D-054): every window, compare the frames the API accepted in the last
 * full window with `MOD_FRAME_BUDGET_PER_SEC` (and the classifier backlog) and publish the
 * multiplier the gateways use to stretch sampling intervals.
 */
export async function updateBudgetMultiplier(deps: {
  redis: Redis;
  budgetPerSec: number;
  backlog: () => Promise<number>;
  now?: () => Date;
}): Promise<number> {
  const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const current = Math.floor(nowSeconds / MOD_FRAMES_WINDOW_SECONDS) * MOD_FRAMES_WINDOW_SECONDS;
  const previousWindow = current - MOD_FRAMES_WINDOW_SECONDS;
  const [counted, stored] = await Promise.all([
    deps.redis.get(moderationFramesKey(previousWindow)),
    deps.redis.get(MOD_BUDGET_MULTIPLIER_KEY),
  ]);
  const next = nextBudgetMultiplier({
    previous: Number(stored ?? '1') || 1,
    observedPerSec: Number(counted ?? '0') / MOD_FRAMES_WINDOW_SECONDS,
    budgetPerSec: deps.budgetPerSec,
    backlog: await deps.backlog(),
  });
  await deps.redis.set(MOD_BUDGET_MULTIPLIER_KEY, String(next), 'EX', MULTIPLIER_TTL_SECONDS);
  return next;
}
