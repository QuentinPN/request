import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { X } from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useId, useRef, useState } from 'react';
import type { MemberOption } from '../../../shared/auth.ts';
import type { MediaDetails, MediaSummary, Season } from '../../../shared/media.ts';
import {
  type CreateRequestInput,
  isAiredSeason,
  isoDay,
  isRequestable,
  type RequestDetail,
  type RequestQuota,
  requestableSeasons,
} from '../../../shared/requests.ts';
import { autoApproves, requestRefusal } from '../../../shared/roles.ts';
import { lockedRequestStatuses } from '../../../shared/status.ts';
import { plural } from '../../../shared/text.ts';
import { useViewer } from '../../hooks/use-viewer.ts';
import { blockLabel } from '../../lib/blocklist.ts';
import { mediaQuery, regularSeasons, seasonMeta, seasonTitle, summaryMeta } from '../../lib/catalogue.ts';
import { errorMessage } from '../../lib/http.ts';
import { useMediaServerName } from '../../lib/media-server.ts';
import {
  arrName,
  memberOptionsQuery,
  myRequestsForQuery,
  requestProgress,
  requestQuotaQuery,
  useCreateRequest,
} from '../../lib/requests.ts';
import { ChoiceRow } from '../choice-row.tsx';
import { StatusPill } from '../media/status-pill.tsx';
import { Notice } from '../notice.tsx';
import { Avatar } from '../shell/avatar.tsx';
import { roundButton } from '../shell/nav-items.ts';
import { Button, buttonVariants } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { CheckboxRow, Input, Label } from '../ui/field.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { RequestThumb } from './request-progress.tsx';

const RequestSheetContext = createContext<((media: MediaSummary, is4k: boolean) => void) | null>(null);

/** Titre de la fiche (saisons connues) ou d'une affiche, d'un hero, d'une liste (résumé seul) : voir `isRequestable`. */
export type RequestableMedia = MediaSummary | MediaDetails;

/**
 * Action « Demander » d'un titre : ouvre la feuille de demande. `undefined` si le membre n'a pas le droit de demander
 * ce type (voir `useRequestRefusal`) ou si le titre n'est pas demandable (disponible, en cours, déjà demandé, ou série
 * dont toutes les saisons le sont) : le bouton ne s'affiche pas. Seule la fiche connaît les saisons : ailleurs, une série
 * déjà demandée reste fermée.
 */
export function useRequestAction(media: RequestableMedia | undefined): (() => void) | undefined {
  const open = useContext(RequestSheetContext);
  const viewer = useViewer();
  const inFlight = useOwnRequestInFlight(media, false);
  if (
    !open ||
    !media ||
    media.blocked ||
    inFlight ||
    !viewer ||
    requestRefusal(viewer.capabilities, { type: media.type, is4k: false }) ||
    !isRequestable(media, isoDay())
  )
    return undefined;
  return () => open(media, false);
}

/**
 * Raison pour laquelle le membre ne peut pas demander ce titre demandable (droit de son type, `requestRefusal`), ou
 * `null` : le bouton « Demander » s'affiche alors désactivé, avec cette raison.
 */
export function useRequestRefusal(media: RequestableMedia | undefined): string | null {
  const viewer = useViewer();
  if (!viewer || !media || media.blocked || !isRequestable(media, isoDay())) return null;
  return requestRefusal(viewer.capabilities, { type: media.type, is4k: false });
}

/**
 * Le membre a déjà une demande approuvée ou échouée pour cette série dans cette qualité : le serveur refuse d'en
 * ajouter une autre tant qu'elle n'est pas envoyée. Lue seulement pour une série aux saisons connues (fiche) quand
 * « Demander » se proposerait. Tant qu'elle charge, on la suppose en cours : le bouton reste caché (pas de 409).
 */
export function useOwnRequestInFlight(media: RequestableMedia | undefined, is4k: boolean): boolean {
  const viewer = useViewer();
  const enabled =
    media?.type === 'tv' &&
    'seasons' in media &&
    !!media.seasons &&
    !!viewer &&
    !requestRefusal(viewer.capabilities, { type: 'tv', is4k }) &&
    isRequestable(media, isoDay(), is4k);
  const mine = useQuery({ ...myRequestsForQuery({ type: 'tv', tmdbId: media?.tmdbId ?? 0 }), enabled });
  return (
    enabled &&
    (mine.isPending || !!mine.data?.results.some((r) => r.is4k === is4k && lockedRequestStatuses.includes(r.status)))
  );
}

/**
 * La 4K se demande seulement si un serveur 4K du type existe (`fourK` présent), si le membre a le droit de demander ce
 * type en 4K et si la version 4K n'est ni disponible, ni en cours, ni déjà demandée.
 */
const can4k = (viewer: ReturnType<typeof useViewer>, media: MediaDetails | undefined): media is MediaDetails =>
  !!media?.fourK &&
  !media.blocked &&
  !!viewer &&
  !requestRefusal(viewer.capabilities, { type: media.type, is4k: true }) &&
  isRequestable(media, isoDay(), true);

/** Action « Demander en 4K » de la fiche (voir `can4k`) : ouvre la feuille en 4K. */
export function useRequest4kAction(media: MediaDetails | undefined): (() => void) | undefined {
  const open = useContext(RequestSheetContext);
  const viewer = useViewer();
  const inFlight = useOwnRequestInFlight(media, true);
  if (!open || inFlight || !can4k(viewer, media)) return undefined;
  return () => open(media, true);
}

/** Saison vue en 4K : statut, progression et épisodes de la version 4K à la place de ceux de la version normale. */
function seasonIn4k({ fourK, status: _status, progress: _progress, episodes: _episodes, ...season }: Season): Season {
  return { ...season, ...fourK };
}

// Ordinateur : dialogue centré (maquette A-Demande). Mobile : feuille posée en bas de l'écran (maquette R-Mobile).
export const bottomSheet = cn(
  'gap-5 overflow-y-auto sm:max-w-none lg:max-w-[560px] lg:p-7',
  'max-lg:top-auto max-lg:bottom-0 max-lg:left-0 max-lg:max-h-[92dvh] max-lg:max-w-none max-lg:translate-x-0 max-lg:translate-y-0',
  'max-lg:rounded-t-[28px] max-lg:rounded-b-none max-lg:px-5 max-lg:pt-3 max-lg:pb-[calc(2rem+env(safe-area-inset-bottom))]',
  'max-lg:data-open:zoom-in-100 max-lg:data-open:slide-in-from-bottom-10',
);

/** Feuille de demande, montée une fois pour toute l'appli : affiches, hero et fiche l'ouvrent par `useRequestAction`. */
export function RequestSheetProvider({ children }: { children: ReactNode }) {
  const [media, setMedia] = useState<MediaSummary | null>(null);
  const [is4k, setIs4k] = useState(false);
  const [open, setOpen] = useState(false);
  // Chaque ouverture repart d'un formulaire neuf (sélection, erreur, confirmation).
  const [session, setSession] = useState(0);
  const show = useCallback((next: MediaSummary, fourK: boolean) => {
    setMedia(next);
    setIs4k(fourK);
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  return (
    <RequestSheetContext value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        {media && (
          <DialogContent showCloseButton={false} className={bottomSheet}>
            <SheetHandle />
            <RequestForm key={session} media={media} is4k={is4k} onClose={() => setOpen(false)} />
          </DialogContent>
        )}
      </Dialog>
    </RequestSheetContext>
  );
}

/** Poignée de la feuille, sur mobile seulement. */
export const SheetHandle = () => (
  <span aria-hidden className="h-[5px] w-10 justify-self-center rounded-full bg-(--track) lg:hidden" />
);

/** En-tête d'une feuille : vignette, ligne facultative au-dessus du titre, titre, description, « Fermer » sur ordinateur. */
export function SheetHeader({
  posterPath,
  eyebrow,
  title,
  description,
}: {
  posterPath: string | null | undefined;
  eyebrow?: ReactNode;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <RequestThumb posterPath={posterPath} className="w-12 lg:w-16" />
      <div className="min-w-0 grow space-y-1">
        {eyebrow && <p className="text-xs text-muted-foreground">{eyebrow}</p>}
        <DialogTitle className="text-lg font-bold lg:text-[22px]">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      <DialogClose aria-label="Fermer" className={cn(roundButton, 'size-10 shrink-0 max-lg:hidden')}>
        <X aria-hidden className="size-5" />
      </DialogClose>
    </div>
  );
}

function RequestForm({ media, is4k: opened4k, onClose }: { media: MediaSummary; is4k: boolean; onClose: () => void }) {
  // Détails lus aussi pour un film : ils disent si la 4K se demande (`fourK`).
  const details = useQuery(mediaQuery(media.type, media.tmdbId));
  const viewer = useViewer();
  const [is4k, setIs4k] = useState(opened4k);
  // Gestionnaires : pour qui (`null` : soi-même) et hors quota.
  const [forUser, setForUser] = useState<MemberOption | null>(null);
  const [quotaExempt, setQuotaExempt] = useState(false);
  // Choix de la version quand les deux se demandent ; ouverte en 4K depuis la fiche, la version normale peut être déjà là.
  const choice = can4k(viewer, details.data) && isRequestable(details.data, isoDay());
  // Changer de version repart d'une sélection neuve (les saisons manquantes ne sont pas les mêmes).
  const bodyProps = { media, is4k, onClose, forUser, quotaExempt };
  let body: ReactNode;
  // Bloqué (liste ou mot-clé, connu par la fiche) : le serveur refuserait, la feuille le dit d'emblée.
  if (details.data?.blocked)
    body = (
      <Notice tone="error" role="alert">
        {blockLabel(details.data.blocked)} : ce titre ne peut pas être demandé.
      </Notice>
    );
  else if (media.type === 'movie') body = <RequestBody key={String(is4k)} {...bodyProps} />;
  else if (details.data) body = <RequestBody key={String(is4k)} {...bodyProps} details={details.data} />;
  else if (details.isPending)
    body = (
      <div role="status" className="space-y-2">
        <span className="sr-only">Chargement des saisons…</span>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-[52px] w-full rounded-card" />
        <Skeleton className="h-[52px] w-full rounded-card" />
      </div>
    );
  else
    body = (
      <Notice tone="error" role="alert">
        Les saisons de cette série n’ont pas pu se charger. Fermez la feuille et réessayez.
      </Notice>
    );
  return (
    <>
      <SheetHeader
        posterPath={media.posterPath}
        eyebrow={
          <>
            {media.type === 'movie' ? 'Demander un film' : 'Demander une série'}
            {is4k && ' en 4K'}
          </>
        }
        title={media.title}
        description={summaryMeta(media).join(' · ')}
      />
      {choice && <QualityChoice is4k={is4k} onChange={setIs4k} />}
      {!details.data?.blocked && (
        <ManagerOptions
          forUser={forUser}
          onForUser={setForUser}
          quotaExempt={quotaExempt}
          onQuotaExempt={setQuotaExempt}
        />
      )}
      {body}
    </>
  );
}

/**
 * Options des gestionnaires : demander à la place d'un membre (droit « Demander pour un autre », « Moi » par défaut) et
 * hors quota (droit de gérer les demandes, quand le quota du membre visé compte). Rien pour un membre.
 */
function ManagerOptions({
  forUser,
  onForUser,
  quotaExempt,
  onQuotaExempt,
}: {
  forUser: MemberOption | null;
  onForUser: (member: MemberOption | null) => void;
  quotaExempt: boolean;
  onQuotaExempt: (exempt: boolean) => void;
}) {
  const capabilities = useViewer()?.capabilities;
  // Même requête que le corps de la feuille (en cache) : « Hors quota » n'a de sens que si le quota compte.
  const quota = useQuery(requestQuotaQuery(forUser?.id));
  if (!capabilities?.canRequestOnBehalf && !capabilities?.canRequestQuotaExempt) return null;
  return (
    <div className="grid gap-3">
      {capabilities.canRequestOnBehalf && <MemberPicker value={forUser} onChange={onForUser} />}
      {capabilities.canRequestQuotaExempt && quota.data?.exempt === false && (
        <CheckboxRow
          checked={quotaExempt}
          onChange={onQuotaExempt}
          label="Hors quota"
          hint={
            forUser
              ? `Ne compte pas dans le quota de ${forUser.name}.`
              : 'Ne compte pas dans le quota du membre à qui elle appartient.'
          }
        />
      )}
    </div>
  );
}

/** Membres affichés au plus pendant une recherche (le membre choisi reste toujours visible). */
const MEMBER_RESULTS = 5;

/** Sélecteur du membre pour qui demander : « Moi », puis une recherche par nom parmi les membres de l'appli. */
function MemberPicker({
  value,
  onChange,
}: {
  value: MemberOption | null;
  onChange: (member: MemberOption | null) => void;
}) {
  const id = useId();
  const viewer = useViewer();
  const members = useQuery(memberOptionsQuery);
  const [search, setSearch] = useState('');
  const term = search.trim().toLocaleLowerCase('fr');
  const others = (members.data ?? []).filter((m) => m.id !== viewer?.id);
  const found = term
    ? others.filter((m) => m.name.toLocaleLowerCase('fr').includes(term)).slice(0, MEMBER_RESULTS)
    : [];
  const shown = value && !found.some((m) => m.id === value.id) ? [value, ...found] : found;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-[13px] font-semibold text-muted-foreground">Demander pour</legend>
      <ChoiceRow name={id} checked={value === null} onSelect={() => onChange(null)}>
        Moi
      </ChoiceRow>
      <div>
        <Label htmlFor={`${id}-search`} className="sr-only">
          Rechercher un membre
        </Label>
        <Input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          placeholder="Rechercher un membre par son nom"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {members.isError && (
        <Notice tone="error" role="alert">
          La liste des membres n’a pas pu se charger.
        </Notice>
      )}
      {term && members.data && found.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun membre ne correspond à « {search.trim()} ».</p>
      )}
      {shown.map((member) => (
        <ChoiceRow key={member.id} name={id} checked={value?.id === member.id} onSelect={() => onChange(member)}>
          <Avatar viewer={member} className="size-7 text-[11px]" />
          <span className="truncate">{member.name}</span>
        </ChoiceRow>
      ))}
    </fieldset>
  );
}

/** Version demandée : standard ou 4K (serveurs 4K à part, statut suivi à part). */
function QualityChoice({ is4k, onChange }: { is4k: boolean; onChange: (is4k: boolean) => void }) {
  const legend = useId();
  return (
    <fieldset aria-labelledby={legend} className="flex flex-wrap items-center gap-2">
      <span id={legend} className="mr-1 text-[13px] font-semibold text-muted-foreground">
        Version
      </span>
      {[false, true].map((fourK) => (
        <Button
          key={String(fourK)}
          type="button"
          variant={is4k === fourK ? 'default' : 'secondary'}
          aria-pressed={is4k === fourK}
          onClick={() => onChange(fourK)}
        >
          {fourK ? 'Demander en 4K' : 'Standard'}
        </Button>
      ))}
    </fieldset>
  );
}

function RequestBody({
  media,
  details,
  is4k,
  onClose,
  forUser,
  quotaExempt,
}: {
  media: MediaSummary;
  details?: MediaDetails;
  is4k: boolean;
  onClose: () => void;
  /** Membre pour qui demander (`null` : soi-même) : son quota et son approbation automatique s'appliquent. */
  forUser: MemberOption | null;
  quotaExempt: boolean;
}) {
  const day = isoDay();
  // Demande 4K : les saisons déjà là, en cours ou demandées le sont en 4K, la version normale ne compte pas.
  const seasons = details ? regularSeasons(details.seasons).map((s) => (is4k ? seasonIn4k(s) : s)) : [];
  const missing = requestableSeasons(seasons, day).map((s) => s.seasonNumber);
  // « Toutes les saisons manquantes » présélectionné.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(missing));
  const mutation = useCreateRequest();
  const submitting = useRef(false);
  const quota = useQuery(requestQuotaQuery(forUser?.id));
  const viewer = useViewer();
  const capabilities = forUser ?? viewer?.capabilities;
  // Pour un autre membre : ses droits à lui (le serveur refuse sinon, 403).
  const refusal = capabilities ? requestRefusal(capabilities, { type: media.type, is4k }) : null;

  const isTv = media.type === 'tv';
  const wanted = isTv ? selected.size : 1;
  const usage = quota.data && !quota.data.exempt ? quota.data[isTv ? 'seasons' : 'movies'] : undefined;
  const overQuota = !quotaExempt && usage !== undefined && wanted > usage.remaining;
  const disabled = wanted === 0 || overQuota || refusal !== null || mutation.isPending;

  if (mutation.data) return <RequestSent request={mutation.data} media={media} onClose={onClose} />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Double clic ou Entrée répétée : une seule demande part.
    if (submitting.current || disabled) return;
    submitting.current = true;
    // `is4k` seulement pour une demande 4K : absent, le serveur en fait une demande normale.
    const options = {
      ...(is4k && { is4k }),
      ...(forUser && { forUserId: forUser.id }),
      // Case cochée puis membre exempté de quota : elle est masquée, rien à envoyer.
      ...(quotaExempt && quota.data?.exempt === false && { quotaExempt }),
    };
    const input: CreateRequestInput = isTv
      ? { type: 'tv', tmdbId: media.tmdbId, seasons: [...selected].sort((a, b) => a - b), ...options }
      : { type: 'movie', tmdbId: media.tmdbId, ...options };
    mutation.mutate(input, {
      onSettled: () => {
        submitting.current = false;
      },
    });
  };

  const toggle = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(n)) next.add(n);
      return next;
    });

  const submitLabel = `${
    isTv ? `Demander ${wanted > 0 ? plural(wanted, 'saison', 'saisons') : 'des saisons'}` : 'Demander ce film'
  }${is4k ? ' en 4K' : ''}`;

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      {isTv && (
        <SeasonPicker
          seasons={seasons}
          missing={missing}
          selected={selected}
          day={day}
          onToggle={toggle}
          onToggleAll={(all) => setSelected(new Set(all ? missing : []))}
        />
      )}
      <QuotaNotice
        quota={quotaExempt ? undefined : quota.data}
        isTv={isTv}
        wanted={wanted}
        arr={arrName(media.type, is4k)}
        autoApprove={!!capabilities && autoApproves(capabilities, { type: media.type, is4k })}
        member={forUser?.name ?? null}
      />
      {refusal && (
        <Notice tone="error" role="alert">
          {forUser ? `${forUser.name} : ${refusal}.` : `${refusal}.`}
        </Notice>
      )}
      {mutation.error && (
        <Notice tone="error" role="alert">
          {errorMessage(mutation.error, 'La demande n’a pas pu être envoyée.')}
        </Notice>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose render={<Button variant="ghost" size="lg" />}>Annuler</DialogClose>
        <Button type="submit" size="lg" disabled={disabled}>
          {mutation.isPending ? 'Envoi…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function SeasonPicker({
  seasons,
  missing,
  selected,
  day,
  onToggle,
  onToggleAll,
}: {
  seasons: Season[];
  missing: number[];
  selected: Set<number>;
  day: string;
  onToggle: (n: number) => void;
  onToggleAll: (all: boolean) => void;
}) {
  const legend = useId();
  const allChecked = missing.length > 0 && missing.every((n) => selected.has(n));
  const check = 'size-[18px] shrink-0 accent-(--brand) disabled:cursor-not-allowed';
  const row =
    'flex items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3.5 has-disabled:opacity-55 has-focus-visible:ring-3 has-focus-visible:ring-ring';
  return (
    <fieldset aria-labelledby={legend} className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span id={legend} className="text-[13px] font-semibold text-muted-foreground">
          Saisons
        </span>
        {missing.length > 1 && (
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              className={check}
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = !allChecked && selected.size > 0;
              }}
              onChange={() => onToggleAll(!allChecked)}
            />
            Toutes les saisons manquantes
          </label>
        )}
      </div>
      {seasons.length === 0 && <p className="text-sm text-muted-foreground">TMDB ne connaît aucune saison.</p>}
      {seasons.map((season) => {
        const requestable = missing.includes(season.seasonNumber);
        const meta = isAiredSeason(season, day) ? seasonMeta(season) : 'Pas encore diffusée';
        return (
          <label key={season.seasonNumber} className={row}>
            <span className="flex min-w-0 items-center gap-3">
              <input
                type="checkbox"
                className={check}
                disabled={!requestable}
                checked={requestable && selected.has(season.seasonNumber)}
                onChange={() => onToggle(season.seasonNumber)}
              />
              <span className="min-w-0">
                <span className="font-semibold">{seasonTitle(season)}</span>{' '}
                <span className="text-[13px] text-muted-foreground">· {meta}</span>
              </span>
            </span>
            {season.status && <StatusPill status={season.status} progress={season.progress} className="shrink-0" />}
          </label>
        );
      })}
      {seasons.length > 0 && missing.length === 0 && (
        <p className="text-sm text-muted-foreground">Toutes les saisons diffusées sont déjà là ou demandées.</p>
      )}
    </fieldset>
  );
}

function QuotaNotice({
  quota,
  isTv,
  wanted,
  arr,
  autoApprove,
  member,
}: {
  quota: RequestQuota | undefined;
  isTv: boolean;
  wanted: number;
  arr: string;
  autoApprove: boolean;
  /** Nom du membre pour qui la demande est faite ; `null` : soi-même. */
  member: string | null;
}) {
  const approval = autoApprove
    ? `Elle part directement à ${arr}.`
    : `Un administrateur la valide avant l’envoi à ${arr}.`;
  // Quota inconnu (chargement, erreur), exempté ou hors quota : le serveur reste juge, seule la consigne d'approbation.
  const usage = quota && !quota.exempt ? quota[isTv ? 'seasons' : 'movies'] : undefined;
  if (!usage) return <Notice tone="info">{approval}</Notice>;
  const unit = (n: number) => plural(n, isTv ? 'saison' : 'film', isTv ? 'saisons' : 'films');
  const period = `par période de ${plural(usage.days, 'jour', 'jours')}`;
  if (usage.remaining === 0)
    return (
      <Notice tone="error" role="alert">
        Quota atteint{member && ` pour ${member}`} : {unit(usage.limit)} {period}.{' '}
        {member
          ? 'Cochez « Hors quota » pour demander quand même.'
          : 'Vous pourrez demander à nouveau quand d’anciennes demandes sortiront de cette période.'}
      </Notice>
    );
  if (wanted > usage.remaining)
    return (
      <Notice tone="error" role="alert">
        Il ne reste que {unit(usage.remaining)} sur {member ? `le quota de ${member}` : 'votre quota'} : retirez des
        saisons.
      </Notice>
    );
  return (
    <Notice tone="info">
      Quota : il {member ? `reste à ${member}` : 'vous reste'} <strong>{unit(usage.remaining)}</strong> sur{' '}
      {usage.limit}, {period}. {approval}
    </Notice>
  );
}

/** Confirmation dans la feuille, sans toast : la pastille du titre se met à jour derrière. */
function RequestSent({
  request,
  media,
  onClose,
}: {
  request: RequestDetail;
  media: MediaSummary;
  onClose: () => void;
}) {
  const progress = requestProgress(request, useMediaServerName());
  return (
    <div className="grid gap-5">
      <Notice tone="ok" role="status">
        <strong>Demande enregistrée.</strong> {progress.detail} pour {media.title}.
      </Notice>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Link to="/demandes" onClick={onClose} className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
          Mes demandes
        </Link>
        <Button size="lg" onClick={onClose}>
          Fermer
        </Button>
      </div>
    </div>
  );
}
