import {
  ISSUE_MESSAGE_MAX,
  type IssueDetail,
  type IssueStatus,
  issueStatusLabels,
  issueTypeLabels,
} from '@shared/issues.ts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { QueryState } from '@/components/query-state';
import { RequestThumb } from '@/components/requests/request-progress';
import { Avatar } from '@/components/shell/avatar';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewer } from '@/hooks/use-viewer';
import { errorMessage } from '@/lib/http';
import {
  issueDetailQuery,
  issueScope,
  issueTitle,
  useIssueComment,
  useReopenIssue,
  useResolveIssue,
} from '@/lib/issues';
import { formatWhen } from '@/lib/requests';

const statusTone: Record<IssueStatus, string> = {
  open: 'border-(--tint-accent-border) bg-(--tint-accent-bg)',
  resolved: 'border-(--tint-ok-border) bg-(--tint-ok-bg) text-(--text-ok)',
};

/** Pastille « Ouvert » / « Résolu ». */
export function IssueStatusPill({ status }: { status: IssueStatus }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-pill border px-2.5 text-xs font-semibold',
        statusTone[status],
      )}
    >
      {issueStatusLabels[status]}
    </span>
  );
}

/** « Sous-titres · Saison 2 · épisode 5 », sans la saison quand tout le titre est concerné. */
export const issueKind = (issue: Pick<IssueDetail, 'type' | 'seasonNumber' | 'episodeNumber'>) =>
  [issueTypeLabels[issue.type], issueScope(issue)].filter(Boolean).join(' · ');

function Person({ person, when }: { person: IssueDetail['author']; when: string }) {
  const name = person?.name ?? 'Ancien membre';
  return (
    <p className="flex items-center gap-2 text-sm">
      <Avatar viewer={person ?? { name, avatarUrl: null }} className="size-7 text-[11px]" />
      <span className="font-semibold">{name}</span>
      <time dateTime={when} className="text-muted-foreground">
        · {formatWhen(when)}
      </time>
    </p>
  );
}

const skeleton = (
  <Loading label="Chargement du signalement…" className="space-y-3">
    <Skeleton className="h-6 w-2/3" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-12 w-full" />
  </Loading>
);

/** Détail d'un signalement : message, fil de commentaires, et les actions que le droit du membre permet. */
export function IssueDetailPanel({ id }: { id: number }) {
  const query = useQuery(issueDetailQuery(id));
  return (
    <QueryState
      query={query}
      skeleton={skeleton}
      errorMessage="Ce signalement n’a pas pu être chargé."
      notFound={{ title: 'Signalement introuvable', description: 'Il n’existe pas, ou il ne vous est pas visible.' }}
    >
      {(issue) => <IssueBody key={issue.id} issue={issue} />}
    </QueryState>
  );
}

function IssueBody({ issue }: { issue: IssueDetail }) {
  const viewer = useViewer();
  const comment = useIssueComment();
  const resolve = useResolveIssue();
  const reopen = useReopenIssue();
  const [draft, setDraft] = useState('');
  const fieldId = useId();

  const canManage = viewer?.capabilities.canManageIssues === true;
  const busy = comment.isPending || resolve.isPending || reopen.isPending;
  const error = comment.error ?? resolve.error ?? reopen.error;
  const title = issueTitle(issue);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() === '' || busy) return;
    comment.mutate({ id: issue.id, message: draft }, { onSuccess: () => setDraft('') });
  };

  return (
    <article aria-label={`Signalement : ${title}`} className="space-y-5">
      <div className="flex gap-4">
        <RequestThumb posterPath={issue.posterPath} className="w-16" />
        <div className="min-w-0 space-y-1.5">
          <IssueStatusPill status={issue.status} />
          <h2 className="text-xl leading-tight font-bold tracking-tight">
            <Link to="/titre/$type/$id" params={{ type: issue.media.type, id: String(issue.media.tmdbId) }}>
              {title}
            </Link>
          </h2>
          <p className="text-[13px] text-muted-foreground">{issueKind(issue)}</p>
        </div>
      </div>

      <div className="space-y-2 rounded-[14px] border border-border bg-(--surface-1) p-4">
        <Person person={issue.author} when={issue.createdAt} />
        <p className="text-sm whitespace-pre-wrap">{issue.message}</p>
      </div>

      {issue.resolvedAt && (
        <p className="text-[13px] text-muted-foreground">
          Résolu par {issue.resolvedBy?.name ?? 'un ancien membre'} · {formatWhen(issue.resolvedAt)}
        </p>
      )}

      {issue.comments.length > 0 && (
        <ol aria-label="Commentaires" className="space-y-4">
          {issue.comments.map((c) => (
            <li key={c.id} className="space-y-1">
              <Person person={c.author} when={c.createdAt} />
              <p className="pl-9 text-sm whitespace-pre-wrap">{c.message}</p>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={fieldId}>Commenter</Label>
          <Textarea
            id={fieldId}
            rows={3}
            maxLength={ISSUE_MESSAGE_MAX}
            value={draft}
            disabled={comment.isPending}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        {error && (
          <Notice tone="error" role="alert">
            {errorMessage(error, 'L’action n’a pas pu aboutir.')}
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {issue.status === 'open' && (canManage || viewer?.id === issue.author?.id) && (
            <Button
              type="button"
              variant="outline"
              className="border-(--tint-ok-border) bg-(--tint-ok-bg) font-semibold text-(--text-ok) hover:bg-(--tint-ok-bg-strong)"
              disabled={busy}
              onClick={() => resolve.mutate(issue.id)}
            >
              Marquer comme résolu
            </Button>
          )}
          {issue.status === 'resolved' && canManage && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => reopen.mutate(issue.id)}>
              Rouvrir
            </Button>
          )}
          <Button type="submit" disabled={busy || draft.trim() === ''}>
            {comment.isPending ? 'Envoi…' : 'Commenter'}
          </Button>
        </div>
      </form>
    </article>
  );
}
