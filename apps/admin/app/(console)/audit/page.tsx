'use client';

import { auditPageSchema } from '@app/shared';
import {
  Button,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/ui';

import { usePaged } from '../../../components/paged-list.ts';
import { formatTime } from '../../../lib/labels.ts';

/** Every admin action (ADMIN only). */
export default function AuditPage() {
  const { items, loading, hasMore, more } = usePaged('/audit', auditPageSchema);
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      {loading ? (
        <Spinner label="Loading" />
      ) : (
        <Table aria-label="Audit log">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatTime(entry.createdAt)}
                </TableCell>
                <TableCell className="text-xs">{entry.adminEmail}</TableCell>
                <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.targetType}
                  {entry.targetId === null ? '' : ` ${entry.targetId.slice(0, 8)}`}
                </TableCell>
                <TableCell className="max-w-sm truncate font-mono text-[11px] text-muted-foreground">
                  {entry.metadata === null || entry.metadata === undefined
                    ? ''
                    : JSON.stringify(entry.metadata)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {hasMore && (
        <Button variant="outline" className="justify-self-center" onClick={() => void more()}>
          Load more
        </Button>
      )}
    </div>
  );
}
