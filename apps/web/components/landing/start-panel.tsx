'use client';

import { CHAT_MODES, type ChatMode, interestSchema, langSchema, MAX_INTERESTS } from '@app/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  cn,
  Label,
  NativeSelect,
  Switch,
  TagInput,
} from '@app/ui';
import { MessageSquareTextIcon, VideoIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { getChatStore, useChat } from '../../lib/chat.ts';
import { LANGUAGE_OPTIONS } from '../../lib/languages.ts';
import { getSession } from '../../lib/session-token.ts';
import { AgeGate } from '../age-gate.tsx';
import { BlockedScreen } from '../blocked-screen.tsx';

const MODE_CARDS: Record<ChatMode, { title: string; description: string; available: boolean }> = {
  text: { title: 'Text chat', description: 'Type with a stranger.', available: true },
  video: { title: 'Video chat', description: 'Face to face, camera on.', available: true },
};

/** Mode, language and interests, then the age gate on first start. */
export function StartPanel() {
  const router = useRouter();
  const preferences = useChat((state) => state.preferences);
  const [gateOpen, setGateOpen] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState<string | null | undefined>(undefined);
  const languageId = useId();
  const autoRequeueId = useId();
  const allowGroupId = useId();
  const update = (change: Partial<typeof preferences>) => {
    getChatStore().getState().setPreferences(change);
  };

  const goChat = () => {
    router.push(`/chat?mode=${preferences.mode}`);
  };

  if (blockedUntil !== undefined) return <BlockedScreen expiresAt={blockedUntil} />;

  return (
    <Card className="w-full">
      <CardContent className="space-y-6 pt-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">How do you want to chat?</legend>
          <div role="radiogroup" className="grid grid-cols-2 gap-3">
            {CHAT_MODES.map((mode) => {
              const card = MODE_CARDS[mode];
              const selected = preferences.mode === mode;
              const Icon = mode === 'text' ? MessageSquareTextIcon : VideoIcon;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!card.available}
                  onClick={() => {
                    update({ mode });
                  }}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                    selected ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <Icon className="size-5" aria-hidden />
                    {!card.available && <Badge variant="muted">Coming soon</Badge>}
                  </span>
                  <span className="text-sm font-semibold">{card.title}</span>
                  <span className="text-xs text-muted-foreground">{card.description}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor={languageId}>Language</Label>
          <NativeSelect
            id={languageId}
            value={preferences.lang}
            onChange={(event) => {
              const lang = langSchema.safeParse(event.target.value);
              if (lang.success) update({ lang: lang.data });
            }}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <TagInput
          label="Interests (optional)"
          value={preferences.interests}
          onChange={(interests) => {
            update({ interests });
          }}
          max={MAX_INTERESTS}
          placeholder="music, gaming, travel…"
          maxInputLength={48}
          normalize={(raw) => {
            const parsed = interestSchema.safeParse(raw);
            return parsed.success ? parsed.data : null;
          }}
        />

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={autoRequeueId} className="font-normal text-muted-foreground">
            Find a new stranger automatically when a chat ends
          </Label>
          <Switch
            id={autoRequeueId}
            checked={preferences.autoRequeue}
            onCheckedChange={(autoRequeue) => {
              update({ autoRequeue });
            }}
          />
        </div>

        {preferences.mode === 'video' && (
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={allowGroupId} className="font-normal text-muted-foreground">
              Let video calls of 3–4 people add me
            </Label>
            <Switch
              id={allowGroupId}
              checked={preferences.allowGroup}
              onCheckedChange={(allowGroup) => {
                update({ allowGroup });
              }}
            />
          </div>
        )}

        <Button
          size="lg"
          className="w-full rounded-full"
          onClick={() => {
            if (getSession() === null) setGateOpen(true);
            else goChat();
          }}
        >
          Start chatting
        </Button>
      </CardContent>

      <AgeGate
        open={gateOpen}
        onOpenChange={setGateOpen}
        onVerified={() => {
          setGateOpen(false);
          goChat();
        }}
        onBlocked={(expiresAt) => {
          setGateOpen(false);
          setBlockedUntil(expiresAt);
        }}
      />
    </Card>
  );
}
