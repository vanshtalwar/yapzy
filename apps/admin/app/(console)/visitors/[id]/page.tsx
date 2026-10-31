'use client';

import { visitorProfileSchema } from '@app/shared';
import { Card, CardContent, CardHeader, CardTitle, Spinner } from '@app/ui';
import { useParams } from 'next/navigation';

import { VisitorSummary } from '../../../../components/visitor-summary.tsx';
import { formatTime } from '../../../../lib/labels.ts';
import { useApi } from '../../../../lib/use-api.ts';

export default function VisitorPage() {
  const { id } = useParams<{ id: string }>();
  const { data: profile, error } = useApi(`/visitors/${id}`, visitorProfileSchema);
  if (profile === null)
    return error === null ? <Spinner label="Loading" /> : <p role="alert">{error.message}</p>;
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">
        Visitor <span className="font-mono text-base">{profile.id}</span>
      </h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <VisitorSummary title="Profile" profile={profile} />
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Moderation events</CardTitle>
          </CardHeader>
          <CardContent>
            {profile.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="grid gap-1 text-xs">
                {profile.events.map((event) => (
                  <li key={event.id}>
                    {formatTime(event.createdAt)} · {event.source.toLowerCase()} · {event.label} (
                    {event.score.toFixed(2)}) · {event.actionTaken.toLowerCase()}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ban history</CardTitle>
        </CardHeader>
        <CardContent>
          {profile.bans.length === 0 ? (
            <p className="text-sm text-muted-foreground">Never banned.</p>
          ) : (
            <ul className="grid gap-1 text-xs">
              {profile.bans.map((ban) => (
                <li key={ban.id}>
                  {formatTime(ban.createdAt)} · {ban.type} · {ban.reason} ·{' '}
                  {ban.revokedAt !== null
                    ? 'revoked'
                    : ban.expiresAt === null
                      ? 'permanent'
                      : `until ${formatTime(ban.expiresAt)}`}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
