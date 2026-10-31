'use client';

import { Button } from '@app/ui';
import { SkipForwardIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const CONFIRM_WINDOW_MS = 3_000;

/**
 * "Next" needs a second press within 3 s (or Esc twice), so a stray click doesn't end a
 * conversation.
 */
export function NextButton({
  onNext,
  disabled = false,
}: {
  onNext: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onNextRef = useRef(onNext);

  useEffect(() => {
    onNextRef.current = onNext;
  }, [onNext]);

  const press = useCallback(() => {
    clearTimeout(timer.current);
    if (armedRef.current) {
      armedRef.current = false;
      setArmed(false);
      onNextRef.current();
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
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') press();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [disabled, press]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Button
      size="sm"
      variant={armed ? 'default' : 'secondary'}
      disabled={disabled}
      onClick={press}
      aria-keyshortcuts="Escape"
    >
      <SkipForwardIcon aria-hidden />
      {armed ? 'Really skip?' : 'Next'}
    </Button>
  );
}
