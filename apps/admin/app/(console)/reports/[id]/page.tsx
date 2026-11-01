'use client';

import { okSchema, reportDetailSchema } from '@app/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Label,
  Spinner,
  Textarea,
  toast,
} from '@app/ui';
import { ArrowLeftIcon, BotIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useId, useState } from 'react';

import { PriorityBadge, ReasonLabel, StatusBadge } from '../../../../components/badges.tsx';
import { type BanChoice, BanFields } from '../../../../components/ban-fields.tsx';
import { EvidenceImage } from '../../../../components/evidence-image.tsx';
import { VisitorSummary } from '../../../../components/visitor-summary.tsx';
import { api, ApiError } from '../../../../lib/api.ts';
import { formatTime, shortId } from '../../../../lib/labels.ts';
import { useSession } from '../../../../lib/session.tsx';
import { authorOf } from '../../../../lib/transcript.ts';
import { useApi } from '../../../../lib/use-api.ts';

type Pending = 'ban' | 'dismiss' | null;

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const { data: report, error, reload } = useApi(`/reports/${id}`, reportDetailSchema);
  const [ban, setBan] = useState<BanChoice>({ type: 'SHADOW', durationHours: 24 * 7 });
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<Pending>(null);
  const noteId = useId();

  if (report === null || me === null) {
    return error === null ? <Spinner label="Loading" /> : <p role="alert">{error.message}</p>;
  }

  const run = async (path: string, body: unknown, done: string) => {
    try {
      await api.post(path, okSchema, body);
      toast(done);
      setNote('');
      await reload();
    } catch (cause) {
      toast(cause instanceof ApiError ? cause.message : 'Action failed');
    }
  };
  const resolved = report.status === 'ACTIONED' || report.status === 'DISMISSED';
  const frames = report.evidence.filter((item) => item.type !== 'TRANSCRIPT');

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden /> Reports
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            <ReasonLabel reason={report.reason} />
          </h1>
          <PriorityBadge priority={report.priority} />
          <StatusBadge status={report.status} />
          {report.automatic && (
            <Badge variant="secondary">
              <BotIcon className="mr-1 size-3" aria-hidden /> Automatic
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {formatTime(report.createdAt)} · session{' '}
          <span className="font-mono">{report.sessionId.slice(0, 8)}</span>
          {report.assignedTo !== null && ` · assigned to ${report.assignedTo}`}
        </p>
        {report.details !== null && (
          <p className="max-w-prose rounded-lg bg-muted p-3 text-sm">“{report.details}”</p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Evidence</CardTitle>
            </CardHeader>
            <CardContent>
              {frames.length === 0 ? (
                <p className="text-sm text-muted-foreground">No images were attached.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {frames.map((item, index) => (
                    <EvidenceImage
                      key={item.id}
                      url={item.url}
                      label={`Frame ${String(index + 1)}`}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transcript</CardTitle>
            </CardHeader>
            <CardContent>
              {report.transcript.length === 0 ? (
                <p className="text-sm text-muted-foreground">No messages.</p>
              ) : (
                <ol className="grid gap-2" aria-label="Transcript">
                  {report.transcript.map((line, index) => {
                    const author = authorOf(line, report);
                    return (
                      <li
                        key={line.id ?? index}
                        className={
                          author.role === 'reporter' ? 'justify-self-end' : 'justify-self-start'
                        }
                      >
                        <p
                          className={`max-w-md rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${author.role === 'reported' ? 'bg-destructive/10' : 'bg-muted'}`}
                        >
                          {line.text}
                        </p>
                        <span className="text-[10px] text-muted-foreground">
                          {author.label}
                          {line.at !== undefined && ` · ${formatTime(line.at)}`}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Decision</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {resolved && report.resolutionNote !== null && (
                <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                  {report.resolutionNote}
                </p>
              )}
              <BanFields role={me.role} value={ban} onChange={setBan} />
              <div className="grid gap-2">
                <Label htmlFor={noteId}>Note (optional)</Label>
                <Textarea
                  id={noteId}
                  rows={2}
                  maxLength={2_000}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirm('ban');
                  }}
                >
                  {ban.type === 'HARD' ? 'Ban' : 'Shadow-ban'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirm('dismiss');
                  }}
                >
                  Dismiss
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void run(`/reports/${report.id}/assign`, {}, 'Assigned to you')}
                >
                  Assign to me
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Trust:</span>
                {[-20, -10, 10].map((delta) => (
                  <Button
                    key={delta}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void run(
                        `/reports/${report.id}/action`,
                        { trustDelta: delta, ...(note === '' ? {} : { note }) },
                        `Trust ${delta > 0 ? '+' : ''}${String(delta)}`,
                      )
                    }
                  >
                    {delta > 0 ? '+' : ''}
                    {delta}
                  </Button>
                ))}
                {note.trim() !== '' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void run(`/reports/${report.id}/note`, { note }, 'Note added')}
                  >
                    Save note only
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          {report.participants.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">People in this chat</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm" aria-label="Participants">
                  {report.participants.map((participant) => (
                    <li key={participant.participantId} className="grid gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={
                            participant.role === 'reported' ? 'font-medium text-destructive' : ''
                          }
                        >
                          {participant.label}
                        </span>
                        <Link
                          href={`/visitors/${participant.visitorId}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {shortId(participant.visitorId)}
                        </Link>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {participant.joinedAt === null
                          ? 'joined —'
                          : `joined ${formatTime(participant.joinedAt)}`}
                        {participant.leftAt !== null && ` · left ${formatTime(participant.leftAt)}`}
                        {participant.leaveReason !== null &&
                          ` (${participant.leaveReason.toLowerCase().replaceAll('_', ' ')})`}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <VisitorSummary title="Reported visitor" profile={report.reported} />
          {report.reporter !== null && (
            <VisitorSummary title="Reporter" profile={report.reporter} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm === 'dismiss'
            ? 'Dismiss this report?'
            : ban.type === 'HARD'
              ? 'Ban this visitor?'
              : 'Shadow-ban this visitor?'
        }
        description={
          confirm === 'dismiss'
            ? 'No action is taken against the reported visitor.'
            : `${ban.type === 'HARD' ? 'They are disconnected immediately and blocked' : 'They leave their current chat (in a group call the others stay) and are only matched with other shadow-banned users'} ${ban.durationHours === null ? 'permanently' : `for ${String(ban.durationHours / 24)} day(s)`}.`
        }
        confirmLabel={confirm === 'dismiss' ? 'Dismiss' : 'Confirm ban'}
        destructive={confirm === 'ban'}
        onConfirm={() =>
          confirm === 'dismiss'
            ? run(`/reports/${report.id}/dismiss`, note === '' ? {} : { note }, 'Report dismissed')
            : run(
                `/reports/${report.id}/action`,
                { ban, ...(note === '' ? {} : { note }) },
                'Ban applied',
              )
        }
      />
    </div>
  );
}
