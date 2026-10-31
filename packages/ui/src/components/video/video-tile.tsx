import { type ComponentProps, type ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface VideoTileProps extends ComponentProps<'div'> {
  /** Visible name chip, e.g. "Stranger" or "You". */
  label?: string;
  /** Covers the video, e.g. "Connecting…" or "Camera off". */
  placeholder?: ReactNode;
  /** Extra overlays (badges, buttons), positioned by the caller. */
  overlay?: ReactNode;
}

/**
 * Frame for one camera image. Pass the `<video>` (or any media element) as children; this
 * component only lays out the frame, label and overlays — media handling stays in the app.
 */
export function VideoTile({
  label,
  placeholder,
  overlay,
  className,
  children,
  ...props
}: VideoTileProps) {
  return (
    <div
      className={cn(
        'relative isolate min-h-0 overflow-hidden rounded-xl bg-stage text-stage-foreground [&_video]:size-full [&_video]:object-cover',
        className,
      )}
      {...props}
    >
      {children}
      {placeholder !== undefined && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stage/85 p-4 text-center text-sm">
          {placeholder}
        </div>
      )}
      {label !== undefined && (
        <span className="absolute bottom-2 left-2 rounded-md bg-stage/60 px-2 py-0.5 text-xs font-medium backdrop-blur-sm">
          {label}
        </span>
      )}
      {overlay}
    </div>
  );
}
