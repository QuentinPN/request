import type { BatchResult, RequestView } from '@shared/requests.ts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DeclineDialog } from '@/components/approvals/decline-dialog';
import { DetailPanel } from '@/components/approvals/detail-panel';
import { FailedBanner } from '@/components/approvals/failed-banner';
import { MobileList, MobileQueue } from '@/components/approvals/mobile-queue';
import { BulkBar, Pager, QueueTable } from '@/components/approvals/queue-table';
import { Notice } from '@/components/notice';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { Loading } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useDesktop } from '@/hooks/use-desktop';
import { useViewer } from '@/hooks/use-viewer';
import {
  type ApprovalTab,
  approvalListQuery,
  approvalTabLabel,
  approvalTabStatuses,
  approvalTabs,
  batchOutcome,
  declineOutcome,
  type Feedback,
  profileName,
  type SendChoice,
  sendOutcome,
  sendTargetOf,
  useApprovalActions,
  useSendOptions,
} from '@/lib/approvals';
import { errorMessage } from '@/lib/http';
import { requestCountsQuery, requestTitle } from '@/lib/requests';

const emptyText: Record<ApprovalTab, { title: string; description: string }> = {
  pending: {
    title: 'Rien à approuver',
    description: 'Les demandes des membres en attente de votre accord s’afficheront ici.',
  },
  failed: {
    title: 'Aucun échec d’envoi',
    description: 'Les demandes que Radarr ou Sonarr n’ont pas pu recevoir s’afficheront ici.',
  },
  history: { title: 'Pas encore d’historique', description: 'Les demandes approuvées ou refusées s’afficheront ici.' },
};

const pill =
  'inline-flex h-9 items-center gap-2 rounded-pill border border-border bg-(--surface-1) px-3.5 text-sm font-medium whitespace-nowrap outline-none transition-colors duration-(--dur) hover:bg-(--surface-3) focus-visible:ring-3 focus-visible:ring-ring aria-pressed:border-transparent aria-pressed:bg-(--fill-selected) aria-pressed:text-(--text-inverse)';

const skeleton = (
  <Loading label="Chargement des demandes…" className="space-y-3">
    <Skeleton className="h-16 w-full" />
    <Skeleton className="h-16 w-full" />
    <Skeleton className="h-16 w-full" />
  </Loading>
);

export function ApprobationsPage() {
  const canManage = useViewer()?.capabilities.canManageRequests === true;
  const desktop = useDesktop();
  const actions = useApprovalActions();
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number>();
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [choices, setChoices] = useState<Record<number, SendChoice>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [declining, setDeclining] = useState<number[] | null>(null);
  const [declineError, setDeclineError] = useState<string | null>(null);

  const list = useQuery(approvalListQuery(tab, page));
  const failedList = useQuery(approvalListQuery('failed', 1));
  const counts = useQuery(requestCountsQuery());
  const rows = list.data?.results ?? [];
  const failed = failedList.data?.results ?? [];
  const failedTotal = failedList.data?.totals.failed ?? 0;
  const targetOf = (request: RequestView) => sendTargetOf(request, choices[request.id]);
  const sendOptionsOf = useSendOptions(canManage && tab !== 'failed' ? rows.map(targetOf) : []);
  const optionsQueryOf = (request: RequestView) => sendOptionsOf(targetOf(request));
  const optionsOf = (request: RequestView) => optionsQueryOf(request)?.data;

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  const checkedIds = rows.filter((r) => checked.has(r.id)).map((r) => r.id);
  const titleOf = (id: number) => {
    const request = rows.find((r) => r.id === id);
    return request ? requestTitle(request) : `Demande n° ${id}`;
  };
  const qualityOf = (request: RequestView) => {
    const options = optionsOf(request);
    const id =
      request.status === 'pending'
        ? (choices[request.id]?.qualityProfileId ?? options?.defaultProfileId)
        : request.qualityProfileId;
    return profileName(options, id);
  };

  const changeTab = (next: ApprovalTab) => {
    setTab(next);
    setPage(1);
    setChecked(new Set());
    setFeedback(null);
  };
  const fail = (error: unknown) => setFeedback({ tone: 'error', lines: [errorMessage(error)] });
  /** Demandes sorties de l'onglet : si la page en est vidée (dernière page), retour à la précédente. */
  const leave = (decided: RequestView[]) => {
    const gone = new Set(decided.filter((r) => !approvalTabStatuses[tab].includes(r.status)).map((r) => r.id));
    if (page > 1 && rows.every((r) => gone.has(r.id))) setPage(page - 1);
  };
  const okRequests = (result: BatchResult) => result.results.flatMap((r) => (r.ok ? [r.request] : []));
  // Après une décision, la sélection passe à la demande voisine plutôt que de revenir en haut.
  const advance = (id: number) => {
    const index = rows.findIndex((r) => r.id === id);
    if (selected?.id === id) setSelectedId((rows[index + 1] ?? rows[index - 1])?.id);
  };

  const approve = (id: number) => {
    setFeedback(null);
    actions.approve.mutate(
      { id, choice: choices[id] },
      {
        onSuccess: (request) => {
          advance(id);
          leave([request]);
          setFeedback(sendOutcome(request));
        },
        onError: fail,
      },
    );
  };
  const retry = (id: number) => {
    setFeedback(null);
    actions.retry.mutate(
      { id },
      {
        onSuccess: (request) => {
          advance(id);
          leave([request]);
          setFeedback(sendOutcome(request));
        },
        onError: fail,
      },
    );
  };
  const approveChecked = () => {
    setFeedback(null);
    actions.batch.mutate(
      { action: 'approve', ids: checkedIds },
      {
        onSuccess: (result) => {
          setChecked(new Set());
          leave(okRequests(result));
          setFeedback(batchOutcome(result, titleOf, 'approve'));
        },
        onError: fail,
      },
    );
  };
  const decline = (ids: number[], reason: string, onError: (message: string) => void) => {
    setFeedback(null);
    const finish = (next: Feedback) => {
      setDeclining(null);
      setChecked(new Set());
      setFeedback(next);
    };
    const [id, ...others] = ids;
    if (id !== undefined && others.length === 0) {
      actions.decline.mutate(
        { id, reason },
        {
          onSuccess: (request) => {
            advance(id);
            leave([request]);
            finish(declineOutcome(request));
          },
          onError: (error) => onError(errorMessage(error)),
        },
      );
      return;
    }
    actions.batch.mutate(
      { action: 'decline', ids, reason },
      {
        onSuccess: (result) => {
          leave(okRequests(result));
          finish(batchOutcome(result, titleOf, 'decline'));
        },
        onError: (error) => onError(errorMessage(error)),
      },
    );
  };
  const askDecline = (ids: number[]) => {
    setDeclineError(null);
    setDeclining(ids);
  };

  const pendingTotal = counts.data?.pendingApprovals ?? list.data?.totals.pending ?? 0;
  const tabCount: Partial<Record<ApprovalTab, string>> = {
    pending: counts.data?.pendingApprovals == null ? undefined : String(counts.data.pendingApprovals),
    failed: failedList.data ? String(failedTotal) : undefined,
  };
  const decliningRequest = declining?.length === 1 ? rows.find((r) => r.id === declining[0]) : undefined;

  const failedBanner = tab === 'pending' && failed[0] && (
    <FailedBanner
      failed={failed[0]}
      more={failedTotal - 1}
      busy={actions.busy}
      onRetry={retry}
      onShowAll={() => changeTab('failed')}
    />
  );

  return (
    <Page title="Approbations">
      <div className="space-y-5">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Filtrer les demandes</legend>
          {approvalTabs.map((id) => (
            <button key={id} type="button" aria-pressed={tab === id} className={pill} onClick={() => changeTab(id)}>
              {approvalTabLabel[id]}
              {tabCount[id] && <span className={'text-xs opacity-75'}>{tabCount[id]}</span>}
            </button>
          ))}
        </fieldset>

        {feedback && (
          <Notice tone={feedback.tone} role={feedback.tone === 'error' ? 'alert' : 'status'}>
            {feedback.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Notice>
        )}
        {desktop && failedBanner}

        <QueryState
          query={list}
          errorMessage="Les demandes n’ont pas pu être chargées."
          empty={emptyText[tab]}
          isEmpty={(data) => data.results.length === 0 && !(page > 1)}
          skeleton={skeleton}
        >
          {(data) =>
            desktop ? (
              <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
                <div className="min-w-0 space-y-4">
                  <QueueTable
                    tab={tab}
                    rows={rows}
                    selectedId={selected?.id}
                    checked={checked}
                    busy={actions.busy}
                    qualityOf={qualityOf}
                    onSelect={setSelectedId}
                    onToggle={(id) =>
                      setChecked((set) => {
                        const next = new Set(set);
                        if (!next.delete(id)) next.add(id);
                        return next;
                      })
                    }
                    onToggleAll={() =>
                      setChecked(checkedIds.length === rows.length ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                    onApprove={approve}
                    onRetry={retry}
                    onDecline={(id) => askDecline([id])}
                  />
                  {tab === 'pending' && (
                    <BulkBar
                      count={checkedIds.length}
                      all={checkedIds.length === rows.length}
                      busy={actions.busy}
                      onApprove={approveChecked}
                      onDecline={() => askDecline(checkedIds)}
                    />
                  )}
                  <Pager page={data.page} totalPages={data.totalPages} onPage={setPage} />
                </div>
                {selected && (
                  <aside
                    aria-label="Détail de la demande"
                    className="sticky top-6 rounded-card bg-(--surface-0) p-6 ring-1 ring-border"
                  >
                    <DetailPanel
                      key={selected.id}
                      tab={tab}
                      request={selected}
                      options={optionsOf(selected)}
                      optionsLoading={optionsQueryOf(selected)?.isPlaceholderData === true}
                      choice={choices[selected.id] ?? {}}
                      onChoice={(patch) =>
                        setChoices((all) => ({ ...all, [selected.id]: { ...all[selected.id], ...patch } }))
                      }
                      busy={actions.busy}
                      onApprove={() => approve(selected.id)}
                      onRetry={() => retry(selected.id)}
                      onDecline={(reason) =>
                        decline([selected.id], reason, (message) => setFeedback({ tone: 'error', lines: [message] }))
                      }
                    />
                  </aside>
                )}
              </div>
            ) : tab === 'pending' ? (
              counts.isPending ? (
                skeleton
              ) : (
                <MobileQueue
                  rows={rows}
                  total={pendingTotal}
                  qualityOf={qualityOf}
                  busy={actions.busy}
                  onApprove={approve}
                  onDecline={(id) => askDecline([id])}
                />
              )
            ) : (
              <div className="space-y-4">
                <MobileList
                  tab={tab}
                  rows={rows}
                  busy={actions.busy}
                  onRetry={retry}
                  onDecline={(id) => askDecline([id])}
                />
                <Pager page={data.page} totalPages={data.totalPages} onPage={setPage} />
              </div>
            )
          }
        </QueryState>
        {/* Mobile : sous la carte, comme la maquette B, pour que les boutons restent dans l'écran. */}
        {!desktop && failedBanner}
      </div>

      {declining && (
        <DeclineDialog
          title={
            decliningRequest ? `Refuser ${requestTitle(decliningRequest)}` : `Refuser ${declining.length} demandes`
          }
          description="Le motif est envoyé au membre. Cette décision est définitive."
          audience={decliningRequest?.requester.name ?? 'les membres concernés'}
          busy={actions.busy}
          error={declineError}
          onConfirm={(reason) => decline(declining, reason, setDeclineError)}
          onClose={() => setDeclining(null)}
        />
      )}
    </Page>
  );
}
