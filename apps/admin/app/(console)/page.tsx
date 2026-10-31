'use client';

import { adminStatsSchema } from '@app/shared';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  LineChart,
  Spinner,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/ui';
import { ClockIcon, FlagIcon, MessagesSquareIcon, UsersIcon } from 'lucide-react';

import { useApi } from '../../lib/use-api.ts';

/** Live overview, refreshed every 5 s. */
export default function DashboardPage() {
  const { data: stats, error } = useApi('/stats', adminStatsSchema, { refreshMs: 5_000 });
  if (stats === null) {
    return error === null ? <Spinner label="Loading" /> : <p role="alert">{error.message}</p>;
  }
  const waitingTotal = Object.values(stats.waiting).reduce((sum, n) => sum + n, 0);
  const lastHour = stats.matchesPerMinute.reduce((sum, point) => sum + point.count, 0);
  const points = stats.matchesPerMinute.map((point) => ({
    label: new Date(point.minute).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }),
    value: point.count,
  }));
  const families = Object.entries(stats.waiting).sort(([, a], [, b]) => b - a);

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Online"
          value={stats.online}
          icon={<UsersIcon aria-hidden />}
          hint="Connected sockets"
        />
        <StatCard
          label="Active chats"
          value={stats.activeSessions}
          icon={<MessagesSquareIcon aria-hidden />}
        />
        <StatCard
          label="Waiting"
          value={waitingTotal}
          icon={<ClockIcon aria-hidden />}
          hint="In all queues"
        />
        <StatCard
          label="Open reports"
          value={stats.openReports.total}
          icon={<FlagIcon aria-hidden />}
          tone={stats.openReports.high > 0 ? 'danger' : 'default'}
          hint={`${String(stats.openReports.high)} high · ${String(stats.openReports.medium)} medium · ${String(stats.openReports.low)} low`}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matches per minute</CardTitle>
          <p className="text-sm text-muted-foreground">
            {lastHour} in the last hour · refreshes every 5 s
          </p>
        </CardHeader>
        <CardContent>
          <LineChart title="Matches per minute, last 60 minutes" points={points} />
        </CardContent>
      </Card>
      <section className="grid gap-2">
        <h2 className="text-base font-semibold">Queues</h2>
        {families.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody is waiting right now.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pool</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Language</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {families.map(([family, count]) => {
                const [pool, mode, lang] = family.split(':');
                return (
                  <TableRow key={family}>
                    <TableCell>{pool}</TableCell>
                    <TableCell>{mode}</TableCell>
                    <TableCell>{lang}</TableCell>
                    <TableCell className="text-right tabular-nums">{count}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
