'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const CONFIRM_WINDOW_MS = 3_000;

/**
 * "Press twice to confirm" for Next: the first press arms it for 3 s, the second (or Esc
 * twice while `enabled`) confirms — a stray click never ends a conversation.
 */
export function useConfirmPress(onConfirm: () => void, enabled: boolean) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onConfirmRef = useRef(onConfirm);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  const press = useCallback(() => {
    clearTimeout(timer.current);
    if (armedRef.current) {
      armedRef.current = false;
      setArmed(false);
      onConfirmRef.current();
      return;
    }
    armedRef.current = true;
    setArmed(true);
    timer.current = setTimeout(() => {
      armedRef.current = false;
      setArmed(false);
    }, CONFIRM_WINDOW_MS);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') press();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled, press]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  return { armed, press };
}
