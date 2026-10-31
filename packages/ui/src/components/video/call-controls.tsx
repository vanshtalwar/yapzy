// Design inspired by 21st.dev "Video Call Controls Bar" by cnippet-dev
// (https://21st.dev/r/cnippet-dev/v-toggle-9) and its "Toolbar" video-call demo: labelled
// icon toggles that turn red when off and a red leave action. Written for this kit (theme
// tokens, toolbar semantics, aria-pressed toggles, 360 px layout); no code was copied.
import { type ComponentProps, type ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export function CallControls({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className={cn(
        'flex items-start justify-center gap-0.5 rounded-2xl border bg-card/95 p-1.5 text-card-foreground shadow-lg backdrop-blur sm:gap-1.5 sm:p-2',
        className,
      )}
      {...props}
    />
  );
}

const tones = {
  default: 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/70',
  /** A toggle that is switched off (muted mic, camera off). */
  off: 'border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25',
  primary: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
  danger: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90',
} as const;

export interface CallControlButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: ReactNode;
  label: string;
  tone?: keyof typeof tones;
  /** Set for toggles (mute, camera): announced as pressed / not pressed. */
  pressed?: boolean;
  /** Small count bubble, e.g. unread messages. */
  badge?: number;
}

export function CallControlButton({
  icon,
  label,
  tone = 'default',
  pressed,
  badge,
  className,
  ...props
}: CallControlButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'group flex w-12 flex-col items-center gap-1 rounded-xl py-1 text-[10px] leading-tight font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:w-16 sm:text-[11px]',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'relative flex size-10 items-center justify-center rounded-xl border transition-colors motion-reduce:transition-none sm:size-11 [&_svg]:size-5',
          tones[tone],
        )}
      >
        {icon}
        {badge !== undefined && badge > 0 && (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] leading-5 text-primary-foreground"
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-muted-foreground">
        {label}
        {badge !== undefined && badge > 0 && <span className="sr-only"> ({badge} new)</span>}
      </span>
    </button>
  );
}
