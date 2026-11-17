import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { X } from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useId, useRef, useState } from 'react';
import type { MediaDetails, MediaSummary, Season } from '../../../shared/media.ts';
import type { CreateRequestInput, RequestDetail, RequestQuota } from '../../../shared/requests.ts';
import { useViewer } from '../../hooks/use-viewer.ts';
import { mediaQuery, plural, regularSeasons, seasonMeta, seasonTitle, summaryMeta } from '../../lib/catalogue.ts';
import { ApiError } from '../../lib/http.ts';
import { arrName, requestProgress, requestQuotaQuery, useCreateRequest } from '../../lib/requests.ts';
import { canRequest } from '../../lib/status.ts';
import { StatusPill } from '../media/status-pill.tsx';
import { Notice } from '../notice.tsx';
import { roundButton } from '../shell/nav-items.ts';
import { Button, buttonVariants } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { RequestThumb } from './request-progress.tsx';

const RequestSheetContext = createContext<((media: MediaSummary) => void) | null>(null);

/**
 * Action « Demander » d'un titre : ouvre la feuille de demande. `undefined` si le membre n'a pas le droit de demander
 * ou si le titre n'est pas demandable (disponible, en cours, déjà demandé) : le bouton ne s'affiche pas.
 */
export function useRequestAction(media: MediaSummary | undefined): (() => void) | undefined {
  const open = useContext(RequestSheetContext);
  const viewer = useViewer();
  if (!open || !media || !viewer?.capabilities.canRequest || !canRequest(media.status)) return undefined;
  return () => open(media);
}

// Ordinateur : dialogue centré (maquette A-Demande). Mobile : feuille posée en bas de l'écran (maquette R-Mobile).
const sheet = cn(
  'gap-5 overflow-y-auto sm:max-w-none lg:max-w-[560px] lg:p-7',
  'max-lg:top-auto max-lg:bottom-0 max-lg:left-0 max-lg:max-h-[92dvh] max-lg:max-w-none max-lg:translate-x-0 max-lg:translate-y-0',
  'max-lg:rounded-t-[28px] max-lg:rounded-b-none max-lg:px-5 max-lg:pt-3 max-lg:pb-[calc(2rem+env(safe-area-inset-bottom))]',
  'max-lg:data-open:zoom-in-100 max-lg:data-open:slide-in-from-bottom-10',
);

/** Feuille de demande, montée une fois pour toute l'appli : affiches, hero et fiche l'ouvrent par `useRequestAction`. */
export function RequestSheetProvider({ children }: { children: ReactNode }) {
  const [media, setMedia] = useState<MediaSummary | null>(null);
  const [open, setOpen] = useState(false);
  // Chaque ouverture repart d'un formulaire neuf (sélection, erreur, confirmation).
  const [session, setSession] = useState(0);
  const show = useCallback((next: MediaSummary) => {
    setMedia(next);
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  return (
    <RequestSheetContext value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        {media && (
          <DialogContent showCloseButton={false} className={sheet}>
            <span aria-hidden className="h-[5px] w-10 justify-self-center rounded-full bg-(--track) lg:hidden" />
            <RequestForm key={session} media={media} onClose={() => setOpen(false)} />
          </DialogContent>
        )}
      </Dialog>
    </RequestSheetContext>
  );
}

function SheetHeader({ media }: { media: MediaSummary }) {
  return (
    <div className="flex items-start gap-4">
      <RequestThumb posterPath={media.posterPath} className="w-12 lg:w-16" />
      <div className="min-w-0 grow space-y-1">
        <p className="text-xs text-muted-foreground">
          {media.type === 'movie' ? 'Demander un film' : 'Demander une série'}
        </p>
        <DialogTitle className="text-lg font-bold lg:text-[22px]">{media.title}</DialogTitle>
        <DialogDescription>{summaryMeta(media).join(' · ')}</DialogDescription>
      </div>
      <DialogClose aria-label="Fermer" className={cn(roundButton, 'size-10 shrink-0 max-lg:hidden')}>
        <X aria-hidden className="size-5" />
      </DialogClose>
    </div>
  );
}

function RequestForm({ media, onClose }: { media: MediaSummary; onClose: () => void }) {
  const details = useQuery({ ...mediaQuery(media.type, media.tmdbId), enabled: media.type === 'tv' });
  let body: ReactNode;
  if (media.type === 'movie') body = <RequestBody media={media} onClose={onClose} />;
  else if (details.data) body = <RequestBody media={media} details={details.data} onClose={onClose} />;
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
      <SheetHeader media={media} />
      {body}
    </>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Une saison se demande si elle est diffusée et ni disponible, ni en cours, ni déjà demandée (règles du serveur). */
const isAired = (season: Season, day: string) => season.episodeCount > 0 && !!season.airDate && season.airDate <= day;
const isRequestable = (season: Season, day: string) => isAired(season, day) && canRequest(season.status);

function RequestBody({
  media,
  details,
  onClose,
}: {
  media: MediaSummary;
  details?: MediaDetails;
  onClose: () => void;
}) {
  const day = today();
  const seasons = details ? regularSeasons(details.seasons) : [];
  const missing = seasons.filter((s) => isRequestable(s, day)).map((s) => s.seasonNumber);
  // « Toutes les saisons manquantes » présélectionné.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(missing));
  const mutation = useCreateRequest();
  const submitting = useRef(false);
  const quota = useQuery(requestQuotaQuery());
  const viewer = useViewer();

  const isTv = media.type === 'tv';
  const wanted = isTv ? selected.size : 1;
  const usage = quota.data && !quota.data.exempt ? quota.data[isTv ? 'seasons' : 'movies'] : undefined;
  const overQuota = usage !== undefined && wanted > usage.remaining;
  const disabled = wanted === 0 || overQuota || mutation.isPending;

  if (mutation.data) return <RequestSent request={mutation.data} media={media} onClose={onClose} />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Double clic ou Entrée répétée : une seule demande part.
    if (submitting.current || disabled) return;
    submitting.current = true;
    const input: CreateRequestInput = isTv
      ? { type: 'tv', tmdbId: media.tmdbId, seasons: [...selected].sort((a, b) => a - b) }
      : { type: 'movie', tmdbId: media.tmdbId };
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

  const submitLabel = isTv
    ? `Demander ${wanted > 0 ? plural(wanted, 'saison', 'saisons') : 'des saisons'}`
    : 'Demander ce film';

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
        quota={quota.data}
        isTv={isTv}
        wanted={wanted}
        arr={arrName(media.type)}
        autoApprove={!!viewer?.capabilities.autoApprove}
      />
      {mutation.error && (
        <Notice tone="error" role="alert">
          {mutation.error instanceof ApiError ? mutation.error.message : 'La demande n’a pas pu être envoyée.'}
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
        const meta = isAired(season, day) ? seasonMeta(season) : 'Pas encore diffusée';
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
}: {
  quota: RequestQuota | undefined;
  isTv: boolean;
  wanted: number;
  arr: string;
  autoApprove: boolean;
}) {
  const approval = autoApprove
    ? `Elle part directement à ${arr}.`
    : `Un administrateur la valide avant l’envoi à ${arr}.`;
  // Quota inconnu (chargement, erreur) ou exempté : le serveur reste juge, seule la consigne d'approbation s'affiche.
  const usage = quota && !quota.exempt ? quota[isTv ? 'seasons' : 'movies'] : undefined;
  if (!usage) return <Notice tone="info">{approval}</Notice>;
  const unit = (n: number) => plural(n, isTv ? 'saison' : 'film', isTv ? 'saisons' : 'films');
  const period = `par période de ${plural(usage.days, 'jour', 'jours')}`;
  if (usage.remaining === 0)
    return (
      <Notice tone="error" role="alert">
        Quota atteint : {unit(usage.limit)} {period}. Vous pourrez demander à nouveau quand d’anciennes demandes
        sortiront de cette période.
      </Notice>
    );
  if (wanted > usage.remaining)
    return (
      <Notice tone="error" role="alert">
        Il ne vous reste que {unit(usage.remaining)} sur votre quota : retirez des saisons.
      </Notice>
    );
  return (
    <Notice tone="info">
      Quota : il vous reste <strong>{unit(usage.remaining)}</strong> sur {usage.limit}, {period}. {approval}
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
  const progress = requestProgress(request);
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
