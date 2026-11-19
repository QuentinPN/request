import { plural } from '@shared/text.ts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Notice } from '@/components/notice';
import { QueryState } from '@/components/query-state';
import { RequestStatusPill, RequestStepBar, RequestThumb } from '@/components/requests/request-progress';
import { useEditRequestAction } from '@/components/requests/request-sheet';
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
import { FieldHint, Label, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewer } from '@/hooks/use-viewer';
import { titleLink } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { useMediaServerName } from '@/lib/media-server';
import {
  ALL_MEMBERS,
  formatDay,
  memberOptionsQuery,
  myRequestsQuery,
  onBehalfLabel,
  requestCountsQuery,
  requestMeta,
  requestProgress,
  requestQuotaQuery,
  totalOf,
  useCancelRequest,
} from '@/lib/requests';
import type { RequestPage, RequestView } from '../../shared/requests.ts';
import { activeRequestStatuses, type RequestStatus } from '../../shared/status.ts';

type FilterId = 'active' | 'available' | 'declined' | 'all';

/**
 * Filtres de Mes demandes, appliqués par le serveur ; `statuses` absent : toutes. Un titre arrivé dans Emby reste
 * « En cours » jusqu'à ce que la synchronisation passe sa demande en `available`.
 */
const filters: { id: FilterId; label: string; statuses?: readonly RequestStatus[]; empty: string }[] = [
  { id: 'active', label: 'En cours', statuses: activeRequestStatuses, empty: 'Aucune demande en cours' },
  {
    id: 'available',
    label: 'Disponibles',
    statuses: ['available'],
    empty: 'Aucune demande disponible pour l’instant',
  },
  { id: 'declined', label: 'Refusées', statuses: ['declined'], empty: 'Aucune demande refusée' },
  { id: 'all', label: 'Toutes', empty: 'Aucune demande pour l’instant' },
];

/** Quota utilisé : le sien, ou celui d'un autre membre (`userId`, gestionnaires). */
function QuotaLine({ userId }: { userId?: string }) {
  const quota = useQuery(requestQuotaQuery(userId));
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
            {errorMessage(cancel.error, 'L’annulation n’a pas abouti.')}
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

/** Hors de ses propres demandes : pas d'annulation, et la liste de tous les membres dit de qui est chaque demande. */
function RequestRow({ request, scope, viewerId }: { request: RequestView; scope: Scope; viewerId?: string }) {
  const progress = requestProgress(request, useMediaServerName());
  const edit = useEditRequestAction(request);
  const title = request.media?.title ?? 'Titre inconnu';
  return (
    <li className={rowBox}>
      <RequestThumb posterPath={request.media?.posterPath} className="w-12 self-start lg:self-center" />
      <div className={rowGrid}>
        <div className="min-w-0">
          <Link
            {...titleLink(request)}
            className="block truncate font-semibold outline-none hover:underline focus-visible:underline"
          >
            {title}
          </Link>
          <p className="truncate text-[13px] text-muted-foreground">{requestMeta(request).join(' · ')}</p>
          {!scope.own && scope.all && (
            <p className="truncate text-xs text-muted-foreground">Membre : {request.requester.name}</p>
          )}
          {request.createdBy && (
            <p className="truncate text-xs text-muted-foreground">
              {onBehalfLabel(request, scope.own ? request.requester.id : viewerId)}
            </p>
          )}
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
      <div className="flex shrink-0 flex-col items-end gap-2 self-start empty:max-lg:hidden lg:w-[200px] lg:flex-row lg:justify-end lg:self-center">
        {edit && (
          <Button variant="secondary" size="sm" onClick={edit}>
            Modifier<span className="sr-only"> la demande de {title}</span>
          </Button>
        )}
        {request.status === 'pending' && scope.own && <CancelRequest request={request} />}
      </div>
    </li>
  );
}

function RowsSkeleton({ own }: { own: boolean }) {
  return (
    <Loading
      label={own ? 'Chargement de vos demandes…' : 'Chargement des demandes…'}
      className="space-y-2 lg:space-y-0 lg:rounded-card lg:border lg:py-2"
    >
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

type Filter = (typeof filters)[number];

/** Qui la page montre : ses propres demandes, celles de tous les membres, ou celles d'un membre (gestionnaires). */
type Scope = { own: true } | { own: false; all: boolean; label: string };

function RequestList({
  scope,
  viewerId,
  filter,
  pages,
  onFilter,
  more,
}: {
  scope: Scope;
  viewerId?: string;
  filter: Filter;
  pages: RequestPage[];
  onFilter: (id: FilterId) => void;
  /** Lit la page suivante ; absent quand tout est affiché. */
  more: { load: () => void; loading: boolean } | undefined;
}) {
  const totals = pages[0]?.totals;
  const requests = pages.flatMap((page) => page.results);
  return (
    <div className="space-y-6">
      <ChipGroup label="Filtrer les demandes">
        {filters.map((f) => (
          <FilterChip key={f.id} pressed={f.id === filter.id} onClick={() => onFilter(f.id)}>
            {f.label}
            <span className="ml-1.5 tabular-nums opacity-70">{totals ? totalOf(totals, f.statuses) : ''}</span>
          </FilterChip>
        ))}
      </ChipGroup>
      {requests.length === 0 ? (
        <EmptyState
          title={filter.empty}
          description={
            scope.own
              ? 'Demandez un film ou une série depuis Découvrir : son avancement s’affichera ici.'
              : 'Aucune demande ne correspond à ce filtre.'
          }
          action={
            scope.own ? (
              <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
                Aller à Découvrir
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul
            aria-label={`Demandes : ${filter.label.toLowerCase()}`}
            className="space-y-2 lg:space-y-0 lg:rounded-card lg:border lg:border-border lg:bg-card lg:py-2"
          >
            {requests.map((request) => (
              <RequestRow key={request.id} request={request} scope={scope} viewerId={viewerId} />
            ))}
          </ul>
          {more && (
            <div className="flex justify-center">
              <Button variant="secondary" disabled={more.loading} onClick={more.load}>
                Charger plus
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Sélecteur des gestionnaires : mes demandes, celles de tous les membres, ou d'un membre. Le choix vit dans
 * l'adresse (`?membre=`), comme le lien « Voir ses demandes » de Réglages › Membres.
 */
function MemberScopePicker({ value, viewerId }: { value: string; viewerId?: string }) {
  const id = useId();
  const navigate = useNavigate();
  const members = useQuery(memberOptionsQuery);
  const others = (members.data ?? []).filter((m) => m.id !== viewerId);
  return (
    <div className="max-w-sm">
      <Label htmlFor={id}>Demandes de</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => void navigate({ to: '/demandes', search: e.target.value ? { membre: e.target.value } : {} })}
      >
        <option value="">Moi</option>
        <option value={ALL_MEMBERS}>Tous les membres</option>
        {value !== '' && value !== ALL_MEMBERS && !others.some((m) => m.id === value) && (
          <option value={value}>Membre inconnu</option>
        )}
        {others.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </NativeSelect>
      {members.isError && (
        <FieldHint className="text-(--text-danger)">La liste des membres n’a pas pu se charger.</FieldHint>
      )}
    </div>
  );
}

/**
 * Mes demandes (maquettes A-Demandes et R-Mobile) : filtres, avancement en quatre étapes, annulation. Un gestionnaire
 * y lit aussi les demandes d'un membre ou de tous (`?membre=`), sans pouvoir annuler celles des autres.
 */
export function DemandesPage() {
  const viewer = useViewer();
  const canManage = viewer?.capabilities.canManageRequests ?? false;
  const { membre } = useSearch({ strict: false });
  // Un membre sans droit de gestion ne lit que les siennes : le paramètre est ignoré (le serveur le fait aussi).
  const member = canManage && membre !== viewer?.id ? membre : undefined;
  const members = useQuery({ ...memberOptionsQuery, enabled: member !== undefined && member !== ALL_MEMBERS });
  const scope: Scope =
    member === undefined
      ? { own: true }
      : member === ALL_MEMBERS
        ? { own: false, all: true, label: 'tous les membres' }
        : { own: false, all: false, label: members.data?.find((m) => m.id === member)?.name ?? 'ce membre' };

  const counts = useQuery(requestCountsQuery());
  const [picked, setPicked] = useState<FilterId>();
  // Sans demande en cours, la page s'ouvre sur toutes les demandes plutôt que sur une liste vide ; celles d'un autre
  // membre s'ouvrent sur toutes (les compteurs sont les siens).
  const initial: FilterId | undefined = !scope.own
    ? 'all'
    : counts.data
      ? counts.data.mineActive > 0
        ? 'active'
        : 'all'
      : counts.isError
        ? 'all'
        : undefined;
  const filter = filters.find((f) => f.id === (picked ?? initial));
  // Changement de filtre : la liste précédente reste affichée (avec ses filtres) le temps de lire la nouvelle.
  const query = useInfiniteQuery({
    ...myRequestsQuery(filter?.statuses, member),
    enabled: !!filter,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {scope.own ? 'Mes demandes' : scope.all ? 'Demandes de tous les membres' : `Demandes de ${scope.label}`}
        </h1>
        {canManage && <MemberScopePicker value={member ?? ''} viewerId={viewer?.id} />}
        {scope.own ? <QuotaLine /> : !scope.all && member && <QuotaLine userId={member} />}
      </header>
      <QueryState
        query={query}
        skeleton={<RowsSkeleton own={scope.own} />}
        errorMessage={scope.own ? 'Vos demandes n’ont pas pu se charger.' : 'Les demandes n’ont pas pu se charger.'}
        empty={
          scope.own
            ? {
                title: 'Aucune demande pour l’instant',
                description:
                  'Vos demandes de films et de séries, avec leur statut et leur progression, apparaîtront ici.',
              }
            : {
                title: 'Aucune demande pour l’instant',
                description: 'Aucune demande de films ou de séries à afficher.',
              }
        }
        isEmpty={(data) => !data.pages[0] || totalOf(data.pages[0].totals) === 0}
      >
        {(data) =>
          filter && (
            <RequestList
              scope={scope}
              viewerId={viewer?.id}
              filter={filter}
              pages={data.pages}
              onFilter={setPicked}
              more={
                query.hasNextPage && !query.isPlaceholderData
                  ? { load: () => void query.fetchNextPage(), loading: query.isFetchingNextPage }
                  : undefined
              }
            />
          )
        }
      </QueryState>
    </div>
  );
}
