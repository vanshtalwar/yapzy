import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from './preferences.ts';

describe('getChatStore', () => {
  it('hydrates with the defaults (like the server HTML) and holds the saved preferences', async () => {
    const saved = {
      mode: 'video',
      lang: 'de',
      interests: ['music'],
      autoRequeue: false,
      allowGroup: false,
    } as const;
    localStorage.setItem('rc.preferences', JSON.stringify(saved));

    const { getChatStore } = await import('./chat.ts');
    const store = getChatStore();

    // zustand's server snapshot (used during hydration) must match the prerendered defaults.
    expect(store.getInitialState().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(store.getState().preferences).toEqual(saved);
  });
});
