import type { RequestView } from '@shared/requests.ts';
import { cn } from 'cn';
import { useState } from 'react';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { type ApprovalTab, approvalTabLabel } from '@/lib/approvals';
import { arrName, formatWhen, requestMeta, requestStatusLabel, requestTitle } from '@/lib/requests';
import { FailureReason } from './queue-table';
import { Requester, RequestPoster } from './request-parts';

type Actions = {
  busy: boolean;
  onApprove: (id: number) => void;
  onRetry: (id: number) => void;
  onDecline: (id: number) => void;
};

/** Mobile, onglet « En attente » : une carte à la fois, Refuser / Approuver en grand, « Plus tard » pour passer. */
export function MobileQueue({
  rows,
  total,
  qualityOf,
  busy,
  onApprove,
  onDecline,
}: Pick<Actions, 'busy' | 'onApprove' | 'onDecline'> & {
  rows: RequestView[];
  /** Demandes en attente au total (la liste n'en porte qu'une page). */
  total: number;
  qualityOf: (request: RequestView) => string;
}) {
  // Les cartes passées avec « Plus tard » repartent en fin de file, dans l'ordre où elles ont été repoussées.
  const [later, setLater] = useState<number[]>([]);
  const [startTotal] = useState(total);
  const queue = [
    ...rows.filter((r) => !later.includes(r.id)),
    ...later.flatMap((id) => rows.find((r) => r.id === id) ?? []),
  ];
  const current = queue[0];

  if (!current)
    return (
      <EmptyState title="Rien à approuver" description="Toutes les demandes ont été traitées. Revenez plus tard." />
    );

  // Traitées depuis l'ouverture de l'écran + celle-ci ; le total suit les nouvelles demandes.
  const done = Math.max(0, startTotal - total);
  const position = done + 1;
  const count = done + total;
  const title = requestTitle(current);

  return (
    <div className="space-y-4">
      <div
        role="progressbar"
        aria-label="Progression du tri"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={position}
        aria-valuetext={`${position} sur ${count}`}
        className="h-1 overflow-hidden rounded-full bg-(--track)"
      >
        <div className="h-full bg-brand" style={{ width: `${(position / count) * 100}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">
        {position} sur {count}
      </p>
      <article aria-label={title} className="glass space-y-4 rounded-card p-5">
        <div className="flex gap-4">
          <RequestPoster media={current.media} size="sm" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm">
              <span className="font-semibold">{current.requester.name}</span>{' '}
              <span className="text-muted-foreground">· {formatWhen(current.createdAt)}</span>
            </p>
            <h2 className="text-2xl leading-tight font-bold tracking-tight">{title}</h2>
            <p className="text-xs text-muted-foreground">{[...requestMeta(current), qualityOf(current)].join(' · ')}</p>
          </div>
        </div>
        {current.media?.overview && (
          <p className="line-clamp-4 rounded-[14px] border border-border bg-(--surface-1) p-3 text-sm text-muted-foreground">
            {current.media.overview}
          </p>
        )}
      </article>
      <div className="flex gap-3">
        <Button
          variant="destructive"
          className="h-16 grow text-base"
          disabled={busy}
          onClick={() => onDecline(current.id)}
        >
          Refuser
        </Button>
        <Button
          variant="outline"
          className="h-16 grow border-(--tint-ok-border) bg-(--tint-ok-bg) text-base font-semibold text-(--text-ok) hover:bg-(--tint-ok-bg-strong)"
          disabled={busy}
          onClick={() => onApprove(current.id)}
        >
          Approuver
        </Button>
      </div>
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy || queue.length < 2}
        onClick={() => setLater((ids) => [...ids.filter((id) => id !== current.id), current.id])}
      >
        Plus tard
      </Button>
    </div>
  );
}

/** Mobile, onglets « Échecs » et « Historique » : une carte compacte par demande. */
export function MobileList({
  tab,
  rows,
  busy,
  onRetry,
  onDecline,
}: Pick<Actions, 'busy' | 'onRetry' | 'onDecline'> & { tab: ApprovalTab; rows: RequestView[] }) {
  return (
    <ul aria-label={approvalTabLabel[tab]} className="space-y-3">
      {rows.map((request) => {
        const title = requestTitle(request);
        return (
          <li key={request.id} className="glass space-y-3 rounded-card p-4">
            <div className="flex gap-3">
              <RequestPoster media={request.media} size="xs" />
              <div className="min-w-0 space-y-1">
                <p className="truncate font-semibold">{title}</p>
                <p className="text-xs text-muted-foreground">
                  {[...requestMeta(request), formatWhen(request.updatedAt)].join(' · ')}
                </p>
                <p className="text-xs">
                  <Requester person={request.requester} />
                </p>
              </div>
            </div>
            {tab === 'failed' && (
              <>
                <p className="text-sm">
                  <FailureReason request={request} />
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="grow"
                    disabled={busy}
                    aria-label={`Refuser ${title}`}
                    onClick={() => onDecline(request.id)}
                  >
                    Refuser
                  </Button>
                  <Button
                    variant="outline"
                    className="grow border-(--tint-ok-border) bg-(--tint-ok-bg) text-(--text-ok)"
                    disabled={busy}
                    aria-label={`Réessayer ${title} (${arrName(request.type)})`}
                    onClick={() => onRetry(request.id)}
                  >
                    Réessayer
                  </Button>
                </div>
              </>
            )}
            {tab === 'history' && (
              <p className={cn('text-sm', request.declineReason && 'text-muted-foreground')}>
                {requestStatusLabel[request.status]}
                {request.declineReason && ` : ${request.declineReason}`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
