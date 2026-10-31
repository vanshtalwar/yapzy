import { describe, expect, it } from 'vitest';

import { isTypingTarget, triageKey } from './triage.ts';

describe('queue triage keys', () => {
  it('moves with j/k within bounds and maps d/s/Enter to actions', () => {
    expect(triageKey('j', 0, 3)).toEqual({ type: 'select', index: 1 });
    expect(triageKey('j', 2, 3)).toEqual({ type: 'select', index: 2 });
    expect(triageKey('k', 0, 3)).toEqual({ type: 'select', index: 0 });
    expect(triageKey('ArrowUp', 2, 3)).toEqual({ type: 'select', index: 1 });
    expect(triageKey('Enter', 1, 3)).toEqual({ type: 'open', index: 1 });
    expect(triageKey('d', 5, 3)).toEqual({ type: 'dismiss', index: 2 });
    expect(triageKey('s', -1, 3)).toEqual({ type: 'shadow', index: 0 });
    expect(triageKey('x', 0, 3)).toBeNull();
    expect(triageKey('j', 0, 0)).toBeNull();
  });

  it('ignores keys typed into fields and dialogs', () => {
    const input = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(button)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});
