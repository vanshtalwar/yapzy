'use client';

import { eventPageSchema, MODERATION_EVENT_SOURCES } from '@app/shared';
import {
  Button,
  FilterChips,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/ui';
import Link from 'next/link';
import { useState } from 'react';

import { usePaged } from '../../../components/paged-list.ts';
import { query } from '../../../lib/api.ts';
import { formatTime, shortId } from '../../../lib/labels.ts';

type Source = (typeof MODERATION_EVENT_SOURCES)[number];
const LABELS: Record<Source, string> = {
  CLIENT_NSFW: 'Client NSFW',
  SERVER_CLASSIFIER: 'Classifier',
  TEXT_FILTER: 'Text filter',
  HASH_MATCH: 'Hash match',
  REPORT_THRESHOLD: 'Report threshold',
};

export default function EventsPage() {
  const [source, setSource] = useState<Source | null>(null);
  const { items, loading, hasMore, more } = usePaged(
    `/moderation-events${query({ source })}`,
    eventPageSchema,
  );
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Moderation events</h1>
      <FilterChips
        label="Source"
        options={MODERATION_EVENT_SOURCES.map((value) => ({ value, label: LABELS[value] }))}
        value={source}
        onChange={setSource}
      />
      {loading ? (
        <Spinner label="Loading" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Visitor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatTime(event.createdAt)}
                </TableCell>
                <TableCell className="text-xs">{LABELS[event.source]}</TableCell>
                <TableCell className="text-xs">{event.label}</TableCell>
                <TableCell className="text-xs tabular-nums">{event.score.toFixed(2)}</TableCell>
                <TableCell className="text-xs">{event.actionTaken.toLowerCase()}</TableCell>
                <TableCell className="font-mono text-xs">
                  <Link className="hover:underline" href={`/visitors/${event.visitorId}`}>
                    {shortId(event.visitorId)}
                  </Link>
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
