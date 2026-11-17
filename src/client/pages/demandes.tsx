import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Notice } from '@/components/notice';
import { QueryState } from '@/components/query-state';
import { RequestStatusPill, RequestStepBar, RequestThumb } from '@/components/requests/request-progress';
import { EmptyState, Loading } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/catalogue';
import { ApiError } from '@/lib/http';
import {
  formatDay,
  isActiveRequest,
  myRequestsQuery,
  requestMeta,
  requestProgress,
  requestQuotaQuery,
  useCancelRequest,
} from '@/lib/requests';
import { REQUESTS_PAGE_SIZE, type RequestView } from '../../shared/requests.ts';

type FilterId = 'active' | 'available' | 'declined' | 'all';

const isAvailable = (r: RequestView) => requestProgress(r).tone === 'available';

/** Filtres de Mes demandes : « En cours » exclut un titre déjà arrivé dans Emby, même avant la synchronisation. */
const filters: { id: FilterId; label: string; match: (r: RequestView) => boolean; empty: string }[] = [
  {
    id: 'active',
    label: 'En cours',
    match: (r) => isActiveRequest(r.status) && !isAvailable(r),
    empty: 'Aucune demande en cours',
  },
  { id: 'available', label: 'Disponibles', match: isAvailable, empty: 'Aucune demande disponible pour l’instant' },
  { id: 'declined', label: 'Refusées', match: (r) => r.status === 'declined', empty: 'Aucune demande refusée' },
  { id: 'all', label: 'Toutes', match: () => true, empty: 'Aucune demande pour l’instant' },
];

function QuotaLine() {
  const quota = useQuery(requestQuotaQuery());
  if (!quota.data || quota.data.exempt) return null;
  const { movies, seasons } = quota.data;
  const days = (n: number) => plural(n, 'jour', 'jours');
  return (
    <p className="text-sm text-muted-foreground">
      Quota utilisé : films {movies.used} / {movies.limit} sur {days(movies.days)}, saisons {seasons.used} /{' '}
      {seasons.limit} sur {days(seasons.days)}
    </p>
  );
}

function CancelRequest({ request }: { request: RequestView }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelRequest();
  const title = request.media?.title ?? 'ce titre';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) cancel.reset();
      }}
    >
      <DialogTrigger render={<Button variant="secondary" size="sm" />}>
        Annuler<span className="sr-only"> la demande de {title}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Annuler la demande de {title} ?</DialogTitle>
        <DialogDescription>
          Elle n’a pas encore été traitée : elle disparaît de la file d’approbation et ne compte plus dans votre quota.
        </DialogDescription>
        {cancel.error && (
          <Notice tone="error" role="alert">
            {cancel.error instanceof ApiError ? cancel.error.message : 'L’annulation n’a pas abouti.'}
          </Notice>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Garder la demande</DialogClose>
          <Button
            variant="destructive"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(request.id, { onSuccess: () => setOpen(false) })}
          >
            Annuler la demande
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const rowBox =
  'flex gap-3 max-lg:rounded-card max-lg:border max-lg:border-border max-lg:bg-card max-lg:p-3 lg:items-center lg:gap-5 lg:border-b lg:border-border lg:px-5 lg:py-3 lg:last:border-b-0';
const rowGrid = 'min-w-0 grow lg:grid lg:grid-cols-[minmax(0,1fr)_300px_170px] lg:items-center lg:gap-6';

function RequestRow({ request }: { request: RequestView }) {
  const progress = requestProgress(request);
  const title = request.media?.title ?? 'Titre inconnu';
  return (
    <li className={rowBox}>
      <RequestThumb posterPath={request.media?.posterPath} className="w-12 self-start lg:self-center" />
      <div className={rowGrid}>
        <div className="min-w-0">
          <Link
            to="/titre/$type/$id"
            params={{ type: request.type, id: String(request.tmdbId) }}
            className="block truncate font-semibold outline-none hover:underline focus-visible:underline"
          >
            {title}
          </Link>
          <p className="truncate text-[13px] text-muted-foreground">{requestMeta(request).join(' · ')}</p>
        </div>
        <div className="mt-2 space-y-1.5 lg:mt-0">
          <RequestStatusPill progress={progress} />
          <RequestStepBar progress={progress} className="max-w-[260px]" />
          <p className="text-xs text-muted-foreground">{progress.detail}</p>
          {request.status === 'declined' && request.declineReason && (
            <p className="text-xs text-(--text-danger)">Motif : {request.declineReason}</p>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground lg:mt-0 lg:text-[13px]">
          Demandée le {formatDay(request.createdAt)}
        </p>
      </div>
      <div className="shrink-0 self-start text-right empty:max-lg:hidden lg:w-24 lg:self-center">
        {request.status === 'pending' && <CancelRequest request={request} />}
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <Loading label="Chargement de vos demandes…" className="space-y-2 lg:space-y-0 lg:rounded-card lg:border lg:py-2">
      {Array.from({ length: 4 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
        <div key={i} aria-hidden className={rowBox}>
          <Skeleton className="aspect-2/3 w-12 rounded-[10px]" />
          <div className="grow space-y-2 self-center">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </Loading>
  );
}

function RequestList({ requests }: { requests: RequestView[] }) {
  // Sans demande en cours, la page s'ouvre sur toutes les demandes plutôt que sur une liste vide.
  const [filterId, setFilterId] = useState<FilterId>(() =>
    requests.some((r) => filters[0]?.match(r)) ? 'active' : 'all',
  );
  const [shown, setShown] = useState(REQUESTS_PAGE_SIZE);
  const filter = filters.find((f) => f.id === filterId) ?? filters[0];
  if (!filter) return null;
  const matching = requests.filter(filter.match);
  return (
    <div className="space-y-6">
      <ChipGroup label="Filtrer les demandes">
        {filters.map((f) => (
          <FilterChip
            key={f.id}
            pressed={f.id === filterId}
            onClick={() => {
              setFilterId(f.id);
              setShown(REQUESTS_PAGE_SIZE);
            }}
          >
            {f.label}
            <span className="ml-1.5 tabular-nums opacity-70">{requests.filter(f.match).length}</span>
          </FilterChip>
        ))}
      </ChipGroup>
      {matching.length === 0 ? (
        <EmptyState
          title={filter.empty}
          description="Demandez un film ou une série depuis Découvrir : son avancement s’affichera ici."
          action={
            <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
              Aller à Découvrir
            </Link>
          }
        />
      ) : (
        <>
          <ul
            aria-label={`Demandes : ${filter.label.toLowerCase()}`}
            className="space-y-2 lg:space-y-0 lg:rounded-card lg:border lg:border-border lg:bg-card lg:py-2"
          >
            {matching.slice(0, shown).map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </ul>
          {matching.length > shown && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + REQUESTS_PAGE_SIZE)}>
                Charger plus
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Mes demandes (maquettes A-Demandes et R-Mobile) : filtres, avancement en quatre étapes, annulation. */
export function DemandesPage() {
  const query = useQuery(myRequestsQuery());
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Mes demandes</h1>
        <QuotaLine />
      </header>
      <QueryState
        query={query}
        skeleton={<RowsSkeleton />}
        errorMessage="Vos demandes n’ont pas pu se charger."
        empty={{
          title: 'Aucune demande pour l’instant',
          description: 'Vos demandes de films et de séries, avec leur statut et leur progression, apparaîtront ici.',
        }}
        isEmpty={(data) => data.length === 0}
      >
        {(requests) => <RequestList requests={requests} />}
      </QueryState>
    </div>
  );
}
