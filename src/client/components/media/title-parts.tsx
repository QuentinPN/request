import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { Bookmark, BookmarkCheck, Plus } from 'lucide-react';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { imageUrl, type MediaDetails, type MediaSummary } from '../../../shared/media.ts';
import { addedMessage } from '../../../shared/watchlist.ts';
import { errorMessage } from '../../lib/http.ts';
import { invalidateAfterRequest } from '../../lib/requests.ts';
import { inWatchlistQuery, useSetInWatchlist } from '../../lib/watchlist.ts';
import { Notice } from '../notice.tsx';
import {
  type RequestableMedia,
  useOwnRequestInFlight,
  useRequest4kAction,
  useRequestAction,
  useRequestRefusal,
} from '../requests/request-sheet.tsx';
import { Button } from '../ui/button.tsx';

// Pièces communes au hero de Découvrir et à la fiche titre (maquettes R-Decouvrir et R-Fiche).

/** Fond TMDB plein cadre avec ses voiles (gauche sur ordinateur, bas partout, haut sous l'en-tête mobile). */
export function Backdrop({ path, className }: { path: string | null; className?: string }) {
  const src = imageUrl(path, 'backdrop');
  return (
    <div aria-hidden className={cn('absolute inset-x-0 top-0 overflow-hidden bg-(--media-base)', className)}>
      {src && (
        <img
          src={src}
          alt=""
          width={1280}
          height={720}
          fetchPriority="high"
          className="size-full object-cover object-[center_20%]"
        />
      )}
      <div className="absolute inset-0 lg:veil-l" />
      <div className="absolute inset-0 veil-b" />
      <div className="absolute inset-x-0 top-0 h-24 veil-t lg:hidden" />
    </div>
  );
}

/** Année, type, durée… séparés par un point (« meta » des maquettes). */
export function MetaLine({ parts, className }: { parts: string[]; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground', className)}>
      {parts.map((part, i) => (
        <Fragment key={part}>
          {i > 0 && <span aria-hidden className="size-[3px] rounded-full bg-current" />}
          <span>{part}</span>
        </Fragment>
      ))}
    </p>
  );
}

/** Pilule de verre (genres de la fiche). */
export function GlassPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[30px] items-center rounded-pill border border-border bg-secondary px-3 text-[13px] [backdrop-filter:var(--blur)]">
      {children}
    </span>
  );
}

/**
 * « Demander » du hero et de la fiche : ouvre la feuille de demande (rien si le titre n'est pas demandable ; désactivé,
 * avec la raison, si le membre n'a pas le droit de demander ce type).
 */
export function RequestButton({ media, className }: { media: RequestableMedia; className?: string }) {
  const onRequest = useRequestAction(media);
  const inFlight = useOwnRequestInFlight(media, false);
  const refusal = useRequestRefusal(media);
  const refusalId = useId();
  if (inFlight)
    return (
      <Notice tone="info" className="basis-full">
        Votre demande précédente est en cours de traitement : vous pourrez demander d’autres saisons une fois qu’elle
        aura été envoyée.
      </Notice>
    );
  if (refusal)
    return (
      <span className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
        <Button size="lg" disabled aria-describedby={refusalId} className="w-full sm:w-auto">
          <Plus data-icon="inline-start" />
          Demander
        </Button>
        <span id={refusalId} className="text-sm text-muted-foreground">
          {refusal}
        </span>
      </span>
    );
  if (!onRequest) return null;
  return (
    <Button size="lg" onClick={onRequest} className={className}>
      <Plus data-icon="inline-start" />
      Demander
    </Button>
  );
}

/** « Demander en 4K » de la fiche, à côté de « Demander » (voir `useRequest4kAction`). */
export function Request4kButton({ media, className }: { media: MediaDetails; className?: string }) {
  const onRequest = useRequest4kAction(media);
  if (!onRequest) return null;
  return (
    <Button size="lg" variant="secondary" onClick={onRequest} className={className}>
      <Plus data-icon="inline-start" />
      Demander en 4K
    </Button>
  );
}

/**
 * « Ajouter à ma liste » / « Dans ma liste » de la fiche : un clic ajoute ou retire le titre de la liste de souhaits du
 * membre ; avec l'option « demander automatiquement », l'ajout dit aussi si le titre a été demandé. Une erreur du
 * serveur ou ce message s'affiche sous les boutons (la ligne d'actions passe à la ligne).
 */
export function WatchlistButton({ media, className }: { media: MediaSummary; className?: string }) {
  const item = { type: media.type, tmdbId: media.tmdbId };
  const query = useQuery(inWatchlistQuery(item));
  const set = useSetInWatchlist(item);
  const client = useQueryClient();
  const [added, setAdded] = useState<string | null>(null);
  const inList = query.data?.inList ?? false;
  const Icon = inList ? BookmarkCheck : Bookmark;
  const toggle = () => {
    setAdded(null);
    set.mutate(!inList, {
      onSuccess: (result) => {
        setAdded(addedMessage(result.autoRequest));
        if (result.autoRequest?.status === 'requested') invalidateAfterRequest(client);
      },
    });
  };
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        className={cn('border-input', className)}
        disabled={query.isPending || set.isPending}
        onClick={toggle}
      >
        <Icon data-icon="inline-start" />
        {inList ? 'Dans ma liste' : 'Ajouter à ma liste'}
      </Button>
      {added && (
        <p role="status" className="order-last basis-full text-sm text-muted-foreground">
          {added}
        </p>
      )}
      {set.isError && (
        <p role="alert" className="order-last basis-full text-sm text-(--text-danger)">
          {errorMessage(set.error, 'La liste n’a pas pu être modifiée.')}
        </p>
      )}
    </>
  );
}

/** Pilules défilantes au doigt sur mobile, sur plusieurs lignes sur ordinateur. */
export const chipRow =
  '-mx-(--space-page) flex gap-2 overflow-x-auto px-(--space-page) py-1 [scrollbar-width:none] lg:flex-wrap';

/** Groupe de filtres en pilules, nommé pour les lecteurs d'écran. */
export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // min-w-0 : un fieldset garde sinon la largeur de ses pilules et déborde de l'écran au lieu de défiler.
    <fieldset className={cn(chipRow, 'min-w-0')}>
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

/** Filtre en pilule (« fp » des maquettes) : genres, type de média. */
export function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex h-9 shrink-0 items-center rounded-pill border border-border bg-card px-3.5 text-sm font-medium whitespace-nowrap transition-colors duration-(--dur) outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring aria-pressed:border-transparent aria-pressed:bg-(--fill-selected) aria-pressed:text-(--text-inverse)"
    >
      {children}
    </button>
  );
}
