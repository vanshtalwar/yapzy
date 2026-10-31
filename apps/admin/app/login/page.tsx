'use client';

import { adminMeSchema, ErrorCode } from '@app/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  OtpInput,
} from '@app/ui';
import { ShieldCheckIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { api, ApiError } from '../../lib/api.ts';
import { useSession } from '../../lib/session.tsx';

export default function LoginPage() {
  const router = useRouter();
  const { me, signedIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();

  useEffect(() => {
    if (me !== null) router.replace('/');
  }, [me, router]);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post('/auth/login', adminMeSchema, {
        email,
        password,
        ...(needsTotp ? { totp } : {}),
      });
      signedIn(result);
      router.replace('/');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === ErrorCode.TOTP_REQUIRED) {
        setNeedsTotp(true);
      } else {
        setTotp('');
        setError(cause instanceof ApiError ? cause.message : 'Sign-in failed');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <ShieldCheckIcon className="mb-2 size-8 text-primary" aria-hidden />
          <CardTitle>RandomChat moderation</CardTitle>
          <CardDescription>
            {needsTotp
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Sign in to continue.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {needsTotp ? (
              <OtpInput value={totp} onChange={setTotp} autoFocus />
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor={emailId}>Email</Label>
                  <Input
                    id={emailId}
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={passwordId}>Password</Label>
                  <Input
                    id={passwordId}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                  />
                </div>
              </>
            )}
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending || (needsTotp && totp.length !== 6)}>
              {pending ? 'Signing in…' : needsTotp ? 'Verify' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
