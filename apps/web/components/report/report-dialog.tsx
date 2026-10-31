'use client';

import { type ReportReason } from '@app/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '@app/ui';
import { FlagIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../lib/api.ts';
import { getChatController } from '../../lib/chat.ts';

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'MINOR_SAFETY', label: 'They seem to be under 18' },
  { value: 'NUDITY_SEXUAL', label: 'Nudity or sexual content' },
  { value: 'VIOLENCE_SELF_HARM', label: 'Violence, threats or self-harm' },
  { value: 'HATE', label: 'Hate speech' },
  { value: 'HARASSMENT', label: 'Harassment or bullying' },
  { value: 'SPAM_SCAM', label: 'Spam, scam or advertising' },
  { value: 'OTHER', label: 'Something else' },
];

const MAX_DETAILS = 500;

/**
 * Report the current stranger. The chat ends right after a successful report; the stranger
 * is never told. Evidence (transcript, their last frames) is attached by the controller.
 */
export function ReportDialog({
  open,
  onOpenChange,
  video,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  video: boolean;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsId = useId();

  const submit = async () => {
    if (reason === null) return;
    setPending(true);
    setError(null);
    try {
      await getChatController().report({ reason, details });
      setReason(null);
      setDetails('');
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'RATE_LIMITED'
          ? 'You’ve sent many reports recently. Please try again later.'
          : 'The report could not be sent. Please try again.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this stranger</DialogTitle>
          <DialogDescription>
            They won’t know you reported them. This chat ends, and our moderators get the recent
            messages{video ? ' and a few frames of their video' : ''}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <RadioGroup
            aria-label="Reason"
            value={reason ?? ''}
            onValueChange={(value) => {
              setReason(value as ReportReason);
            }}
          >
            {REASONS.map((option) => {
              const id = `${detailsId}-${option.value}`;
              return (
                <div key={option.value} className="flex items-center gap-3">
                  <RadioGroupItem id={id} value={option.value} />
                  <Label htmlFor={id} className="font-normal">
                    {option.label}
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
          <div className="grid gap-2">
            <Label htmlFor={detailsId}>Anything else? (optional)</Label>
            <Textarea
              id={detailsId}
              value={details}
              maxLength={MAX_DETAILS}
              rows={3}
              onChange={(event) => {
                setDetails(event.target.value);
              }}
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" variant="destructive" disabled={reason === null || pending}>
            <FlagIcon aria-hidden /> {pending ? 'Sending…' : 'Report and leave'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
