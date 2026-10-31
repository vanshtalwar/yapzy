/**
 * Keyboard triage of the reports queue: j/k move, Enter opens, d dismisses, s shadow-bans
 * (both behind a confirmation). Pure so it can be unit-tested.
 */
export type TriageAction =
  | { type: 'select'; index: number }
  | { type: 'open'; index: number }
  | { type: 'dismiss'; index: number }
  | { type: 'shadow'; index: number }
  | null;

export function triageKey(key: string, selected: number, count: number): TriageAction {
  if (count === 0) return null;
  const current = Math.min(Math.max(selected, 0), count - 1);
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return { type: 'select', index: Math.min(current + 1, count - 1) };
    case 'k':
    case 'ArrowUp':
      return { type: 'select', index: Math.max(current - 1, 0) };
    case 'Enter':
      return { type: 'open', index: current };
    case 'd':
      return { type: 'dismiss', index: current };
    case 's':
      return { type: 'shadow', index: current };
    default:
      return null;
  }
}

/** Shortcuts never fire while typing in a field or with modifier keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role=dialog]') !== null
  );
}
