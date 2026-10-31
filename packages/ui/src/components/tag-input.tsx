'use client';

// Design inspired by 21st.dev "Tag Input" by ddoemonn (chips, "Enter adds · Backspace removes"
// hint, n / max counter). Written in-house; no code copied.
import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';

import { cn } from '../lib/cn.ts';

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  max: number;
  /** Turns raw input into a tag, or null if it is not a valid tag. */
  normalize?: (raw: string) => string | null;
  placeholder?: string;
  label: string;
  /** Max characters typed into the field. */
  maxInputLength?: number;
  disabled?: boolean;
}

export function TagInput({
  value,
  onChange,
  max,
  normalize = (raw) => raw.trim() || null,
  placeholder = 'Add a tag',
  label,
  maxInputLength = 64,
  disabled = false,
}: TagInputProps) {
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const full = value.length >= max;

  const commit = () => {
    const tag = normalize(draft);
    if (tag === null) {
      if (draft.trim() !== '') setNote('Use letters or numbers');
      return;
    }
    if (value.includes(tag)) {
      setNote(`“${tag}” is already added`);
    } else if (full) {
      setNote(`Up to ${String(max)}`);
    } else {
      onChange([...value, tag]);
      setNote(null);
    }
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',') && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div
        className={cn(
          'flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring',
          disabled && 'opacity-50',
        )}
      >
        <ul className="contents" aria-label={`${label} added`}>
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-md border bg-secondary py-0.5 pr-1 pl-2 text-sm text-secondary-foreground"
            >
              {tag}
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((other) => other !== tag));
                }}
                className="rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${tag}`}
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <input
          id={inputId}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value.slice(0, maxInputLength));
            setNote(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim() !== '') commit();
          }}
          disabled={disabled || full}
          placeholder={full ? `Maximum ${String(max)} reached` : placeholder}
          aria-describedby={hintId}
          enterKeyHint="done"
          className="h-7 min-w-24 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        />
      </div>
      <div
        id={hintId}
        className="flex justify-between text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span>{note ?? 'Enter adds · Backspace removes'}</span>
        <span className="tabular-nums">
          {value.length} / {max}
        </span>
      </div>
    </div>
  );
}
