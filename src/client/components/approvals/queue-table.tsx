import type { RequestView } from '@shared/requests.ts';
import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { type KeyboardEvent, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { type ApprovalTab, approvalTabLabel } from '@/lib/approvals';
import {
  failureReason,
  formatWhen,
  requestDetailQuery,
  requestMeta,
  requestStatusLabel,
  requestTitle,
} from '@/lib/requests';
import { approveClass, Requester, RequestPoster } from './request-parts';

const checkbox = 'size-[18px] cursor-pointer accent-(--brand) disabled:cursor-default';

/** Raison de l'échec d'un envoi, lue sur la fiche de la demande (la liste ne la porte pas). */
export function FailureReason({ id }: { id: number }) {
  const { data, isPending } = useQuery(requestDetailQuery(id));
  const reason = data && failureReason(data);
  return <span className="text-(--text-danger)">{reason ?? (isPending ? '…' : 'Envoi impossible')}</span>;
}

type Props = {
  tab: ApprovalTab;
  rows: RequestView[];
  selectedId: number | undefined;
  checked: ReadonlySet<number>;
  busy: boolean;
  /** Profil de qualité affiché dans la colonne « Qualité ». */
  qualityOf: (request: RequestView) => string;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  onToggleAll: () => void;
  onApprove: (id: number) => void;
  onRetry: (id: number) => void;
  onDecline: (id: number) => void;
};

/** Tableau de l'ordinateur ; ↑ ↓ déplacent la sélection sans quitter la colonne des titres. */
export function QueueTable({
  tab,
  rows,
  selectedId,
  checked,
  busy,
  qualityOf,
  onSelect,
  onToggle,
  onToggleAll,
  onApprove,
  onRetry,
  onDecline,
}: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
  const selectable = tab === 'pending';
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const from = event.target instanceof HTMLElement ? event.target.dataset.select : undefined;
    if (!step || from === undefined) return;
    const next = rows[rows.findIndex((r) => String(r.id) === from) + step];
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    tableRef.current?.querySelector<HTMLElement>(`[data-select="${next.id}"]`)?.focus();
  };

  return (
    <table ref={tableRef} onKeyDown={onKeyDown} className="w-full border-separate border-spacing-0 text-sm">
      <caption className="sr-only">Demandes : {approvalTabLabel[tab].toLowerCase()}</caption>
      <thead>
        <tr className="text-left text-xs font-semibold text-muted-foreground">
          {selectable && (
            <th scope="col" className="w-10 px-3 py-2.5">
              <input
                type="checkbox"
                className={checkbox}
                aria-label="Tout sélectionner"
                checked={allChecked}
                disabled={busy}
                onChange={onToggleAll}
              />
            </th>
          )}
          <th scope="col" className="px-3 py-2.5 font-semibold">
            Titre
          </th>
          <th scope="col" className="px-3 py-2.5 font-semibold">
            Demandé par
          </th>
          <th scope="col" className="px-3 py-2.5 font-semibold">
            {tab === 'failed' ? 'Raison' : tab === 'history' ? 'Statut' : 'Qualité'}
          </th>
          <th scope="col" className="px-3 py-2.5 font-semibold">
            Quand
          </th>
          {tab !== 'history' && (
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Actions
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((request) => {
          const title = requestTitle(request);
          const selected = request.id === selectedId;
          const cell = cn('border-b border-border px-3 py-3 align-middle', selected && 'bg-muted');
          return (
            <tr key={request.id} data-selected={selected || undefined}>
              {selectable && (
                <td className={cn(cell, 'rounded-l-[10px]')}>
                  <input
                    type="checkbox"
                    className={checkbox}
                    aria-label={`Sélectionner ${title}`}
                    checked={checked.has(request.id)}
                    disabled={busy}
                    onChange={() => onToggle(request.id)}
                  />
                </td>
              )}
              <td className={cn(cell, !selectable && 'rounded-l-[10px]')}>
                <button
                  type="button"
                  data-select={request.id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(request.id)}
                  className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <RequestPoster media={request.media} size="xs" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {requestMeta(request).join(' · ')}
                    </span>
                  </span>
                </button>
              </td>
              <td className={cell}>
                <Requester person={request.requester} />
              </td>
              <td className={cn(cell, 'max-w-56')}>
                {tab === 'failed' ? (
                  <FailureReason id={request.id} />
                ) : tab === 'history' ? (
                  requestStatusLabel[request.status]
                ) : (
                  qualityOf(request)
                )}
              </td>
              <td
                className={cn(cell, 'whitespace-nowrap text-muted-foreground', tab === 'history' && 'rounded-r-[10px]')}
              >
                {formatWhen(request.updatedAt)}
              </td>
              {tab !== 'history' && (
                <td className={cn(cell, 'rounded-r-[10px]')}>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`Refuser ${title}`}
                      onClick={() => onDecline(request.id)}
                    >
                      Refuser
                    </Button>
                    {tab === 'pending' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className={approveClass}
                        disabled={busy}
                        aria-label={`Approuver ${title}`}
                        onClick={() => onApprove(request.id)}
                      >
                        Approuver
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className={approveClass}
                        disabled={busy}
                        aria-label={`Réessayer ${title}`}
                        onClick={() => onRetry(request.id)}
                      >
                        Réessayer
                      </Button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Barre sous le tableau : actions sur les demandes cochées. « Tout approuver » quand la page entière l'est. */
export function BulkBar({
  count,
  all,
  busy,
  onApprove,
  onDecline,
}: {
  count: number;
  all: boolean;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span aria-live="polite">
        {count === 0 ? 'Aucune sélection' : `${count} sélectionnée${count > 1 ? 's' : ''}`}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={busy || count === 0} onClick={onDecline}>
          Refuser la sélection
        </Button>
        <Button size="sm" variant="outline" className={approveClass} disabled={busy || count === 0} onClick={onApprove}>
          {all ? 'Tout approuver' : 'Approuver la sélection'}
        </Button>
      </div>
    </div>
  );
}

/** Pagination des listes (20 demandes par page). */
export function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Précédent
      </Button>
      <span>
        Page {page} sur {totalPages}
      </span>
      <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Suivant
      </Button>
    </nav>
  );
}
