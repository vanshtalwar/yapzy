'use client';

// Source: 21st.dev — "Multi-Consent Registration Gate" by cnippet-dev
// (https://21st.dev/r/cnippet-dev/v-checkbox-10), adapted: consent list + submit button that
// counts remaining required items kept; items/labels/handlers passed in (presentational);
// optional marketing consent removed; a slot for the bot check; pending/error states; theme
// tokens and our Checkbox/Button.
import { type ReactNode, useId } from 'react';

import { Button } from './button.tsx';
import { Checkbox } from './checkbox.tsx';
import { Spinner } from './spinner.tsx';

export interface ConsentItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
}

export interface ConsentGateProps {
  title: ReactNode;
  description?: ReactNode;
  items: ConsentItem[];
  accepted: Record<string, boolean>;
  onAcceptedChange: (id: string, accepted: boolean) => void;
  /** Extra content between the list and the button (e.g. the Turnstile widget). */
  children?: ReactNode;
  /** Whatever else must be true to submit (e.g. bot check solved). */
  ready?: boolean;
  notReadyLabel?: string;
  submitLabel: string;
  pending?: boolean;
  error?: ReactNode;
  onSubmit: () => void;
}

export function ConsentGate({
  title,
  description,
  items,
  accepted,
  onAcceptedChange,
  children,
  ready = true,
  notReadyLabel = 'Complete the check above',
  submitLabel,
  pending = false,
  error,
  onSubmit,
}: ConsentGateProps) {
  const fieldId = useId();
  const remaining = items.filter((item) => accepted[item.id] !== true).length;
  const allAccepted = remaining === 0;

  return (
    <form
      className="w-full space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (allAccepted && ready && !pending) onSubmit();
      }}
    >
      <div>
        <p className="text-base font-semibold">{title}</p>
        {description !== undefined && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="space-y-4">
        {items.map((item) => {
          const id = `${fieldId}-${item.id}`;
          return (
            <div className="flex items-start gap-3" key={item.id}>
              <Checkbox
                id={id}
                checked={accepted[item.id] === true}
                onCheckedChange={(value) => {
                  onAcceptedChange(item.id, value === true);
                }}
                aria-describedby={item.description === undefined ? undefined : `${id}-desc`}
              />
              <div className="flex flex-col gap-0.5">
                <label className="cursor-pointer text-sm leading-snug font-medium" htmlFor={id}>
                  {item.label}
                </label>
                {item.description !== undefined && (
                  <p id={`${id}-desc`} className="text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {children}

      {error !== undefined && error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={!allAccepted || !ready || pending}>
        {pending ? (
          <Spinner label="Please wait" />
        ) : allAccepted ? (
          ready ? (
            submitLabel
          ) : (
            notReadyLabel
          )
        ) : (
          `${String(remaining)} required ${remaining === 1 ? 'item' : 'items'} remaining`
        )}
      </Button>
    </form>
  );
}
