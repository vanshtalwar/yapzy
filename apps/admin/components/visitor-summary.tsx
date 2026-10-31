import { type VisitorProfile } from '@app/shared';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@app/ui';
import Link from 'next/link';

import { formatTime, REASON_LABELS, shortId } from '../lib/labels.ts';

/** Metadata-only overview of a visitor (trust, history), linking to the full profile. */
export function VisitorSummary({ title, profile }: { title: string; profile: VisitorProfile }) {
  const activeBans = profile.bans.filter((ban) => ban.active);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>{title}</span>
          <Link
            href={`/visitors/${profile.id}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            {shortId(profile.id)}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Trust</dt>
          <dd className="tabular-nums">{profile.trustScore}</dd>
          <dt className="text-muted-foreground">Sessions</dt>
          <dd className="tabular-nums">{profile.sessions}</dd>
          <dt className="text-muted-foreground">Reports received</dt>
          <dd className="tabular-nums">
            {profile.reportsReceived} ({profile.reportsReceived30d} in 30 d)
          </dd>
          <dt className="text-muted-foreground">Reports filed</dt>
          <dd className="tabular-nums">{profile.reportsFiled}</dd>
          <dt className="text-muted-foreground">First seen</dt>
          <dd>{formatTime(profile.firstSeenAt)}</dd>
        </dl>
        {activeBans.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {activeBans.map((ban) => (
              <Badge key={ban.id} variant={ban.type === 'HARD' ? 'default' : 'secondary'}>
                {ban.type === 'HARD' ? 'Banned' : 'Shadow-banned'}
                {ban.expiresAt === null ? ' · permanent' : ` · until ${formatTime(ban.expiresAt)}`}
              </Badge>
            ))}
          </div>
        )}
        {profile.recentReports.length > 0 && (
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {profile.recentReports.slice(0, 5).map((report) => (
              <li key={report.id}>
                <Link href={`/reports/${report.id}`} className="hover:underline">
                  {REASON_LABELS[report.reason]} · {report.status.toLowerCase()} ·{' '}
                  {formatTime(report.createdAt)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
