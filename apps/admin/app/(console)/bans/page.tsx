'use client';

import { banPageSchema, okSchema } from '@app/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Input,
  Label,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@app/ui';
import Link from 'next/link';
import { useId, useState } from 'react';

import { type BanChoice, BanFields } from '../../../components/ban-fields.tsx';
import { usePaged } from '../../../components/paged-list.ts';
import { api, ApiError, query } from '../../../lib/api.ts';
import { formatTime, shortId } from '../../../lib/labels.ts';
import { useSession } from '../../../lib/session.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function BansPage() {
  const { me } = useSession();
  const [search, setSearch] = useState('');
  const visitorFilter = UUID.test(search.trim()) ? search.trim() : undefined;
  const { items, loading, hasMore, more, reload } = usePaged(
    `/bans${query({ visitorId: visitorFilter, active: true })}`,
    banPageSchema,
  );
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [ban, setBan] = useState<BanChoice>({ type: 'SHADOW', durationHours: 24 });
  const [revoke, setRevoke] = useState<string | null>(null);
  const ids = { search: useId(), target: useId(), reason: useId() };

  if (me === null) return null;
  const create = async () => {
    try {
      await api.post('/bans', okSchema, { visitorId: target.trim(), reason, ...ban });
      toast('Ban applied');
      setTarget('');
      setReason('');
      reload();
    } catch (cause) {
      toast(cause instanceof ApiError ? cause.message : 'Ban failed');
    }
  };

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Bans</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ban a visitor</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={ids.target}>Visitor id</Label>
              <Input
                id={ids.target}
                required
                pattern="[0-9a-fA-F-]{36}"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
                className="font-mono"
              />
              <Label htmlFor={ids.reason}>Reason</Label>
              <Input
                id={ids.reason}
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
            <div className="grid content-start gap-4">
              <BanFields role={me.role} value={ban} onChange={setBan} />
              <Button type="submit" variant="destructive" className="justify-self-start">
                Apply ban
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-base font-semibold">Active bans</h2>
          <div className="grid gap-1">
            <Label htmlFor={ids.search} className="text-xs">
              Filter by visitor id
            </Label>
            <Input
              id={ids.search}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              className="w-80 max-w-full font-mono"
              placeholder="uuid"
            />
          </div>
        </div>
        {loading ? (
          <Spinner label="Loading" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active bans.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Until</TableHead>
                <TableHead>By</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-xs">
                    {item.visitorId === null ? (
                      '—'
                    ) : (
                      <Link className="hover:underline" href={`/visitors/${item.visitorId}`}>
                        {shortId(item.visitorId)}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.type === 'HARD' ? 'default' : 'secondary'}>
                      {item.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs">{item.reason}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {item.expiresAt === null ? 'Permanent' : formatTime(item.expiresAt)}
                  </TableCell>
                  <TableCell className="text-xs">{item.createdBy ?? 'automatic'}</TableCell>
                  <TableCell className="text-right">
                    {me.role === 'ADMIN' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRevoke(item.id);
                        }}
                      >
                        Revoke
                      </Button>
                    )}
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
      </section>
      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={(open) => {
          if (!open) setRevoke(null);
        }}
        title="Revoke this ban?"
        description="The visitor can chat normally again on their next connection."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoke === null) return;
          try {
            await api.post(`/bans/${revoke}/revoke`, okSchema);
            toast('Ban revoked');
            reload();
          } catch (cause) {
            toast(cause instanceof ApiError ? cause.message : 'Revoke failed');
          }
        }}
      />
    </div>
  );
}
