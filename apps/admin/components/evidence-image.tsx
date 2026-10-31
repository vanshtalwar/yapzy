'use client';

import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * Evidence is blurred until the moderator chooses to look (moderator wellbeing). The URL is
 * a 5-minute presigned link to our own evidence store.
 */
export function EvidenceImage({ url, label }: { url: string | null; label: string }) {
  const [revealed, setRevealed] = useState(false);
  if (url === null) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg border text-xs text-muted-foreground">
        Unavailable
      </div>
    );
  }
  return (
    <figure className="grid gap-1">
      <button
        type="button"
        aria-pressed={revealed}
        aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
        className="group relative overflow-hidden rounded-lg border bg-stage outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setRevealed((value) => !value);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived URL */}
        <img
          src={url}
          alt={label}
          className={
            revealed
              ? 'aspect-video w-full object-contain'
              : 'aspect-video w-full scale-110 object-contain blur-2xl'
          }
          referrerPolicy="no-referrer"
        />
        {!revealed && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-medium text-stage-foreground">
            <EyeOffIcon className="size-5" aria-hidden /> Click to reveal
          </span>
        )}
        {revealed && (
          <span className="absolute top-2 right-2 rounded-full bg-stage/70 p-1 text-stage-foreground">
            <EyeIcon className="size-3.5" aria-hidden />
          </span>
        )}
      </button>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
