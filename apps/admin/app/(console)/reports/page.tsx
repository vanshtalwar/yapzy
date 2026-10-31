'use client';

import {
  okSchema,
  REPORT_REASONS,
  REPORT_STATUSES,
  type ReportListItem,
  reportPageSchema,
  type ReportReason,
} from '@app/shared';
import {
  Button,
  ConfirmDialog,
  FilterChips,
  SortButton,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@app/ui';
import { BotIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { PriorityBadge, ReasonLabel, StatusBadge } from '../../../components/badges.tsx';
import { api, ApiError, query } from '../../../lib/api.ts';
import { formatTime, REASON_LABELS, shortId, STATUS_LABELS } from '../../../lib/labels.ts';
import { isTypingTarget, triageKey } from '../../../lib/triage.ts';

type Status = (typeof REPORT_STATUSES)[number];
interface Sort {
  column: 'priority' | 'createdAt';
  direction: 'asc' | 'desc';
}

export default function ReportsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>('OPEN');
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [sort, setSort] = useState<Sort>({ column: 'priority', direction: 'desc' });
  const [confirm, setConfirm] = useState<{
    kind: 'dismiss' | 'shadow';
    report: ReportListItem;
  } | null>(null);
  const [version, setVersion] = useState(0);

  const path = (after: string | null) =>
    `/reports${query({ status, reason, cursor: after, limit: 25 })}`;

  useEffect(() => {
    let active = true;
    api.get(path(null), reportPageSchema).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setSelected(0);
        setLoading(false);
      },
      () => {
        if (active) setLoading(false);
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path() depends on these
  }, [status, reason, version]);

  const sorted = useMemo(() => {
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...items].sort((a, b) =>
      sort.column === 'priority'
        ? factor * (a.priority - b.priority)
        : factor * a.createdAt.localeCompare(b.createdAt),
    );
  }, [items, sort]);

  // Keyboard triage: j/k move, Enter opens, d dismisses, s shadow-bans (with confirmation).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const action = triageKey(event.key, selected, sorted.length);
      if (action === null) return;
      event.preventDefault();
      if (action.type === 'select') {
        setSelected(action.index);
        return;
      }
      const report = sorted[action.index];
      if (report === undefined) return;
      if (action.type === 'open') router.push(`/reports/${report.id}`);
      else setConfirm({ kind: action.type, report });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [selected, sorted, router]);

  const toggleSort = (column: Sort['column']) => {
    setSort((current) => ({
      column,
      direction: current.column === column && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };
  const ariaSort = (column: Sort['column']) =>
    sort.column === column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  const act = async () => {
    if (confirm === null) return;
    try {
      if (confirm.kind === 'dismiss') {
        await api.post(`/reports/${confirm.report.id}/dismiss`, okSchema, {});
        toast('Report dismissed');
      } else {
        await api.post(`/reports/${confirm.report.id}/action`, okSchema, {
          ban: { type: 'SHADOW', durationHours: 24 * 7 },
        });
        toast('Shadow-banned for 7 days');
      }
      setVersion((v) => v + 1);
    } catch (cause) {
      toast(cause instanceof ApiError ? cause.message : 'Action failed');
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-xs text-muted-foreground">
          <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd>{' '}
          move · <kbd className="rounded border px-1">Enter</kbd> open ·{' '}
          <kbd className="rounded border px-1">d</kbd> dismiss ·{' '}
          <kbd className="rounded border px-1">s</kbd> shadow-ban
        </p>
      </div>
      <div className="grid gap-2">
        <FilterChips
          label="Status"
          options={REPORT_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
          value={status}
          onChange={setStatus}
        />
        <FilterChips
          label="Reason"
          options={REPORT_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }))}
          value={reason}
          onChange={setReason}
        />
      </div>
      {loading ? (
        <Spinner label="Loading" />
      ) : sorted.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          Nothing in this queue. 🎉
        </p>
      ) : (
        <Table aria-label="Reports queue">
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort('priority')}>
                <SortButton
                  label="Priority"
                  direction={sort.column === 'priority' ? sort.direction : null}
                  onClick={() => {
                    toggleSort('priority');
                  }}
                />
              </TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reported</TableHead>
              <TableHead>Evidence</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead aria-sort={ariaSort('createdAt')}>
                <SortButton
                  label="Created"
                  direction={sort.column === 'createdAt' ? sort.direction : null}
                  onClick={() => {
                    toggleSort('createdAt');
                  }}
                />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((report, index) => (
              <TableRow
                key={report.id}
                data-selected={index === selected}
                aria-selected={index === selected}
                className="cursor-pointer"
                onClick={() => {
                  setSelected(index);
                  router.push(`/reports/${report.id}`);
                }}
              >
                <TableCell>
                  <PriorityBadge priority={report.priority} />
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    {report.automatic && (
                      <BotIcon className="size-3.5 text-muted-foreground" aria-label="Automatic" />
                    )}
                    <Link
                      href={`/reports/${report.id}`}
                      className="hover:underline"
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <ReasonLabel reason={report.reason} />
                    </Link>
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={report.status} />
                </TableCell>
                <TableCell className="font-mono text-xs">{shortId(report.reportedId)}</TableCell>
                <TableCell className="tabular-nums">{report.evidenceCount}</TableCell>
                <TableCell className="text-xs">{report.assignedTo ?? '—'}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatTime(report.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {cursor !== null && (
        <Button
          variant="outline"
          className="justify-self-center"
          onClick={() => {
            void api.get(path(cursor), reportPageSchema).then((page) => {
              setItems((current) => [...current, ...page.items]);
              setCursor(page.nextCursor);
            });
          }}
        >
          Load more
        </Button>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.kind === 'dismiss' ? 'Dismiss this report?' : 'Shadow-ban for 7 days?'}
        description={
          confirm === null
            ? undefined
            : `${REASON_LABELS[confirm.report.reason]} · reported visitor ${shortId(confirm.report.reportedId)}`
        }
        confirmLabel={confirm?.kind === 'dismiss' ? 'Dismiss' : 'Shadow-ban'}
        destructive={confirm?.kind === 'shadow'}
        onConfirm={act}
      />
    </div>
  );
}
