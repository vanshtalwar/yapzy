import { queueJoinSchema, type QueuePreferences } from '@app/shared';

import { readJson, writeItem } from './storage.ts';

const KEY = 'rc.preferences';

export const DEFAULT_PREFERENCES: QueuePreferences = {
  mode: 'text',
  lang: 'en',
  interests: [],
  autoRequeue: true,
  allowGroup: false,
};

/** Last used mode/language/interests/auto-requeue, validated like a `queue:join` payload. */
export function loadPreferences(): QueuePreferences {
  const parsed = queueJoinSchema.safeParse(readJson('local', KEY));
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export function savePreferences(preferences: QueuePreferences): void {
  writeItem('local', KEY, JSON.stringify(preferences));
}
