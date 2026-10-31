'use client';

import { Button } from '@app/ui';
import { SkipForwardIcon } from 'lucide-react';

import { useConfirmPress } from './use-confirm-press.ts';

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
  const { armed, press } = useConfirmPress(onNext, !disabled);
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
