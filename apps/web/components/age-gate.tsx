'use client';

import { ErrorCode, type PublicConfig } from '@app/shared';
import {
  ConsentGate,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@app/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { publicConfig } from '../lib/config.ts';
import { getAcceptedTosVersion, setAcceptedTosVersion } from '../lib/consent.ts';
import { getDeviceId } from '../lib/device.ts';
import { saveSession } from '../lib/session-token.ts';
import { Turnstile } from './turnstile.tsx';

type Consent = 'age' | 'terms' | 'privacy';

const none = (): Record<Consent, boolean> => ({ age: false, terms: false, privacy: false });

export interface AgeGateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onBlocked: (expiresAt: string | null) => void;
}

const linkClass = 'underline underline-offset-2 hover:text-primary';

/**
 * 18+ confirmation, Terms/Privacy/Guidelines acceptance and the Turnstile bot check, then
 * POST /v1/session. Returning visitors who accepted the current ToS version get the boxes
 * pre-checked but still pass the bot check (sessions are per tab).
 */
export function AgeGate({ open, onOpenChange, onVerified, onBlocked }: AgeGateProps) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [accepted, setAccepted] = useState<Record<Consent, boolean>>(none);
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the current ToS version when the gate opens (and again after TOS_OUTDATED).
  useEffect(() => {
    if (!open || config !== null) return;
    let active = true;
    api.getConfig().then(
      (loaded) => {
        if (!active) return;
        setConfig(loaded);
        if (getAcceptedTosVersion() === loaded.tosVersion) {
          setAccepted({ age: true, terms: true, privacy: true });
        }
      },
      () => {
        if (active) setError('Cannot reach RandomChat right now. Please try again in a moment.');
      },
    );
    return () => {
      active = false;
    };
  }, [open, config]);

  const freshCheck = () => {
    setToken(null);
    setAttempt((n) => n + 1); // remount Turnstile: tokens are single-use
  };

  const submit = async () => {
    if (config === null || token === null) return;
    setPending(true);
    setError(null);
    try {
      const session = await api.createSession({
        turnstileToken: token,
        ageConfirmed: accepted.age,
        tosVersion: config.tosVersion,
        deviceId: getDeviceId(),
      });
      saveSession(session);
      setAcceptedTosVersion(config.tosVersion);
      onVerified();
    } catch (cause) {
      freshCheck();
      if (!(cause instanceof ApiError)) {
        setError('Something went wrong. Please try again.');
      } else if (cause.code === ErrorCode.BANNED) {
        const expiresAt = cause.details.expiresAt;
        onBlocked(typeof expiresAt === 'string' ? expiresAt : null);
      } else if (cause.code === ErrorCode.TOS_OUTDATED) {
        setAccepted(none());
        setConfig(null);
        setError('Our terms were just updated — please review and accept them again.');
      } else if (cause.code === ErrorCode.TURNSTILE_FAILED) {
        setError('The bot check didn’t pass. Please try again.');
      } else if (cause.code === ErrorCode.RATE_LIMITED) {
        setError('Too many attempts. Please wait a minute and try again.');
      } else {
        setError(cause.message);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Before you start</DialogTitle>
          <DialogDescription>
            RandomChat connects you with random strangers. Please confirm the following.
          </DialogDescription>
        </DialogHeader>
        {config === null ? (
          <div className="flex justify-center py-8">
            {error === null ? <Spinner label="Loading" /> : <p className="text-sm">{error}</p>}
          </div>
        ) : (
          <ConsentGate
            title="Required"
            items={[
              {
                id: 'age',
                label: 'I am 18 or older',
                description: 'RandomChat is for adults only.',
              },
              {
                id: 'terms',
                label: (
                  <>
                    I accept the{' '}
                    <Link className={linkClass} href="/terms" target="_blank">
                      Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link className={linkClass} href="/guidelines" target="_blank">
                      Community Guidelines
                    </Link>
                  </>
                ),
                description: `Version ${config.tosVersion}. Breaking the guidelines can get you banned.`,
              },
              {
                id: 'privacy',
                label: (
                  <>
                    I have read the{' '}
                    <Link className={linkClass} href="/privacy" target="_blank">
                      Privacy Policy
                    </Link>
                  </>
                ),
                description:
                  'Chats aren’t stored, but reported conversations are kept as evidence and video may be checked for safety.',
              },
            ]}
            accepted={accepted}
            onAcceptedChange={(id, value) => {
              setAccepted((previous) => ({ ...previous, [id]: value }));
            }}
            ready={token !== null}
            notReadyLabel="Complete the check above"
            submitLabel="Start chatting"
            pending={pending}
            error={error}
            onSubmit={() => void submit()}
          >
            <Turnstile
              key={attempt}
              siteKey={publicConfig.turnstileSiteKey}
              onToken={setToken}
              onExpire={() => {
                setToken(null);
              }}
              onError={() => {
                setToken(null);
                setError('The bot check could not load. Check your connection and try again.');
              }}
            />
          </ConsentGate>
        )}
      </DialogContent>
    </Dialog>
  );
}
