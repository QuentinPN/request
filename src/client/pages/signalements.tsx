import type { IssueStatus, IssueView } from '@shared/issues.ts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { Pager } from '@/components/approvals/queue-table';
import { accountBack } from '@/components/back-button';
import { IssueDetailPanel, IssueStatusPill, issueKind } from '@/components/issues/issue-detail';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { RequestThumb } from '@/components/requests/request-progress';
import { bottomSheet } from '@/components/requests/request-sheet';
import { Loading } from '@/components/states';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useDesktop } from '@/hooks/use-desktop';
import { useViewer } from '@/hooks/use-viewer';
import { issueListQuery, issueStatusTabs, issueTabLabel, issueTitle } from '@/lib/issues';
import { formatWhen } from '@/lib/requests';

const skeleton = (
  <Loading label="Chargement des signalements…" className="space-y-3">
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
  </Loading>
);

/** Un signalement dans la liste : carte cliquable, la même sur ordinateur (qui sélectionne) et sur mobile (qui ouvre). */
function IssueCard({ issue, selected, onSelect }: { issue: IssueView; selected: boolean; onSelect: () => void }) {
  const title = issueTitle(issue);
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cn(
        'glass flex w-full gap-3 rounded-card p-4 text-left outline-none transition-colors duration-(--dur) hover:bg-(--surface-3) focus-visible:ring-3 focus-visible:ring-ring',
        selected && 'ring-2 ring-brand',
      )}
    >
      <RequestThumb posterPath={issue.posterPath} className="w-12" />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex items-start justify-between gap-3">
          <span className="truncate font-semibold">{title}</span>
          <IssueStatusPill status={issue.status} />
        </span>
        <span className="text-xs text-muted-foreground">
          {[issueKind(issue), issue.author?.name ?? 'Ancien membre', formatWhen(issue.createdAt)].join(' · ')}
        </span>
        <span className="line-clamp-2 text-sm">{issue.message}</span>
      </span>
    </button>
  );
}

export function SignalementsPage() {
  const desktop = useDesktop();
  const canManage = useViewer()?.capabilities.canManageIssues === true;
  const navigate = useNavigate();
  // `?id=` : le signalement ouvert (lien d'une notification) ; absent, le premier de la liste sur ordinateur.
  const { id } = useSearch({ strict: false });
  const [tab, setTab] = useState<IssueStatus>('open');
  const [page, setPage] = useState(1);
  const list = useQuery(issueListQuery(tab, page));
  const select = (next?: number) =>
    void navigate({ to: '/signalements', search: next ? { id: next } : {}, replace: true });
  const changeTab = (next: IssueStatus) => {
    setTab(next);
    setPage(1);
    select();
  };
  // Sur ordinateur, le premier de la liste est épinglé dans l'adresse : résolu, il sort des « Ouverts » sans que le
  // panneau ne saute sur le suivant ni ne disparaisse avant d'avoir affiché « Résolu par … ».
  const firstId = list.data?.results[0]?.id;
  useEffect(() => {
    if (desktop && id === undefined && firstId !== undefined)
      void navigate({ to: '/signalements', search: { id: firstId }, replace: true });
  }, [desktop, id, firstId, navigate]);
  const totals = list.data?.totals;
  const empty =
    tab === 'open'
      ? {
          title: 'Aucun signalement ouvert',
          description: canManage
            ? 'Les problèmes signalés par les membres s’afficheront ici.'
            : 'Signalez un problème depuis la fiche d’un titre disponible : vous le suivrez ici.',
        }
      : { title: 'Aucun signalement résolu', description: 'Les signalements résolus s’afficheront ici.' };

  return (
    <Page title="Signalements" back={accountBack}>
      <div className="space-y-5">
        <ChipGroup label="Filtrer les signalements">
          {issueStatusTabs.map((status) => (
            <FilterChip key={status} pressed={tab === status} onClick={() => changeTab(status)}>
              {issueTabLabel[status]}
              {totals && <span className="ml-2 text-xs opacity-75">{totals[status]}</span>}
            </FilterChip>
          ))}
        </ChipGroup>

        <QueryState
          query={list}
          skeleton={skeleton}
          errorMessage="Les signalements n’ont pas pu être chargés."
          empty={empty}
          isEmpty={(data) => data.results.length === 0 && page === 1 && id === undefined}
        >
          {(data) => {
            const selectedId = id ?? (desktop ? data.results[0]?.id : undefined);
            return (
              <div className={cn('grid items-start gap-8', desktop && 'lg:grid-cols-[minmax(0,1fr)_440px]')}>
                <div className="min-w-0 space-y-4">
                  <ul aria-label={issueTabLabel[tab]} className="space-y-3">
                    {data.results.map((issue) => (
                      <li key={issue.id}>
                        <IssueCard issue={issue} selected={issue.id === selectedId} onSelect={() => select(issue.id)} />
                      </li>
                    ))}
                  </ul>
                  <Pager page={data.page} totalPages={data.totalPages} onPage={setPage} />
                </div>
                {desktop && selectedId !== undefined && (
                  <aside
                    aria-label="Détail du signalement"
                    className="sticky top-6 rounded-card bg-(--surface-0) p-6 ring-1 ring-border"
                  >
                    <IssueDetailPanel id={selectedId} />
                  </aside>
                )}
              </div>
            );
          }}
        </QueryState>
      </div>

      {!desktop && (
        <Dialog open={id !== undefined} onOpenChange={(open) => !open && select()}>
          <DialogContent className={bottomSheet}>
            <span aria-hidden className="h-[5px] w-10 justify-self-center rounded-full bg-(--track)" />
            <DialogTitle className="sr-only">Détail du signalement</DialogTitle>
            <DialogDescription className="sr-only">Message, commentaires et actions du signalement.</DialogDescription>
            {id !== undefined && <IssueDetailPanel id={id} />}
          </DialogContent>
        </Dialog>
      )}
    </Page>
  );
}
