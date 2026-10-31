'use client';

import { okSchema, totpSetupResponseSchema } from '@app/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  OtpInput,
  toast,
} from '@app/ui';
import { ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';

import { api, ApiError } from '../../../lib/api.ts';
import { useSession } from '../../../lib/session.tsx';

/** Two-factor enrolment (TOTP): scan the QR code, confirm with a code. */
export default function SettingsPage() {
  const { me, refresh } = useSession();
  const [setup, setSetup] = useState<{ qrDataUrl: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  if (me === null) return null;

  return (
    <div className="grid max-w-xl gap-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      {me.totpRequired && !me.totpEnabled && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          Set up two-factor authentication to continue. The dashboard is locked until it is on.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-5" aria-hidden /> Two-factor authentication
          </CardTitle>
          <CardDescription>
            {me.totpEnabled
              ? 'On. Signing in requires a code from your authenticator app.'
              : 'Off. Turn it on to require a one-time code when signing in.'}
          </CardDescription>
        </CardHeader>
        {!me.totpEnabled && (
          <CardContent className="grid gap-4">
            {setup === null ? (
              <Button
                className="justify-self-start"
                onClick={() => {
                  api
                    .post('/auth/totp/setup', totpSetupResponseSchema)
                    .then(setSetup, (cause: unknown) => {
                      toast(cause instanceof ApiError ? cause.message : 'Setup failed');
                    });
                }}
              >
                Set up two-factor
              </Button>
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data: URL */}
                <img
                  src={setup.qrDataUrl}
                  alt="QR code for your authenticator app"
                  width={200}
                  height={200}
                  className="rounded-lg border bg-white p-2"
                />
                <details className="text-xs text-muted-foreground">
                  <summary>Can’t scan? Show the setup key</summary>
                  <code className="break-all">{setup.otpauthUrl}</code>
                </details>
                <OtpInput value={code} onChange={setCode} />
                <Button
                  className="justify-self-start"
                  disabled={code.length !== 6}
                  onClick={() => {
                    api.post('/auth/totp/verify', okSchema, { code }).then(
                      async () => {
                        toast('Two-factor authentication is on');
                        setSetup(null);
                        await refresh();
                      },
                      (cause: unknown) => {
                        toast(cause instanceof ApiError ? cause.message : 'Invalid code');
                        setCode('');
                      },
                    );
                  }}
                >
                  Turn on
                </Button>
              </>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
