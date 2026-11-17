import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Film, Play, Plus } from 'lucide-react';
import { imageUrl, type MediaSummary, type MediaType } from '../../../shared/media.ts';
import type { Availability } from '../../../shared/status.ts';
import { summaryMeta } from '../../lib/catalogue.ts';
import { useEmbyWatchUrl } from '../../lib/emby.ts';
import { canRequest } from '../../lib/status.ts';
import { useRequestAction } from '../requests/request-sheet.tsx';
import { Button, buttonVariants } from '../ui/button.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { DownloadBar, StatusPill } from './status-pill.tsx';

/** `rail` : largeur fixe (--poster-w) dans une rangée ; `grid` : remplit la colonne d'une grille. */
type PosterLayout = 'rail' | 'grid';
const width: Record<PosterLayout, string> = { rail: 'w-(--poster-w) shrink-0', grid: 'w-full' };

/**
 * Affiche 2:3 : pastille de statut en haut à droite, barre de téléchargement en bas, « Demander » au survol
 * et au focus, toujours visible au toucher. L'élévation au focus suit --focus-scale (1 en mouvement réduit).
 * Le lien vers la fiche porte le nom accessible ; l'image est décorative (`alt=""`) pour ne pas le répéter.
 */
export function Poster({
  title,
  subtitle,
  src,
  status,
  progress,
  to,
  layout = 'rail',
  onRequest,
  watchUrl,
}: {
  title: string;
  subtitle?: string;
  src?: string;
  status?: Availability['status'];
  progress?: Availability['progress'];
  to: { type: MediaType; id: number };
  layout?: PosterLayout;
  onRequest?: () => void;
  /** « Regarder dans Emby » : adresse du titre dans l'interface web d'Emby (titre disponible ou partiel). */
  watchUrl?: string;
}) {
  const askable = onRequest !== undefined && canRequest(status);
  return (
    <article className={cn('group/poster relative', width[layout])}>
      <div className="relative aspect-2/3 overflow-hidden rounded-poster bg-(--media-base) ring-1 ring-border transition-[transform,box-shadow] duration-(--dur) ease-request group-focus-within/poster:scale-(--focus-scale) group-focus-within/poster:shadow-(--shadow-lift) group-focus-within/poster:ring-2 group-focus-within/poster:ring-ring group-hover/poster:scale-(--focus-scale) group-hover/poster:shadow-(--shadow-lift)">
        {src ? (
          <img src={src} alt="" loading="lazy" width={342} height={513} className="size-full object-cover" />
        ) : (
          <div aria-hidden className="grid size-full place-items-center text-(--on-media-2)/40">
            <Film className="size-8" strokeWidth={1.5} />
          </div>
        )}
        <Link
          to="/titre/$type/$id"
          params={{ type: to.type, id: String(to.id) }}
          className="absolute inset-0 rounded-poster outline-none"
        >
          <span className="sr-only">{subtitle ? `${title} (${subtitle})` : title}</span>
        </Link>
        {status && (
          <StatusPill
            status={status}
            progress={progress}
            onMedia
            className="pointer-events-none absolute top-2 right-2"
          />
        )}
        {(askable || watchUrl) && (
          <div className="absolute inset-x-2 bottom-2 flex gap-1.5 opacity-0 transition-opacity duration-(--dur) group-focus-within/poster:opacity-100 group-hover/poster:opacity-100 pointer-coarse:opacity-100">
            {askable && (
              <Button size="sm" className="min-w-0 grow" onClick={onRequest} aria-label={`Demander ${title}`}>
                <Plus data-icon="inline-start" />
                Demander
              </Button>
            )}
            {watchUrl && (
              // Seul, « Regarder » prend la place de « Demander » ; à côté, il se réduit à son icône (largeur d'une affiche).
              <a
                href={watchUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Regarder ${title} dans Emby`}
                className={buttonVariants({
                  variant: askable ? 'secondary' : 'default',
                  size: askable ? 'icon-sm' : 'sm',
                  className: askable ? 'shrink-0 border-input' : 'w-full',
                })}
              >
                <Play data-icon={askable ? undefined : 'inline-start'} />
                {!askable && 'Regarder'}
              </a>
            )}
          </div>
        )}
        <DownloadBar
          status={status}
          progress={progress}
          label={`Téléchargement de ${title}`}
          className="pointer-events-none absolute inset-x-0 bottom-0"
        />
      </div>
      <div aria-hidden className="mt-2 px-0.5">
        <p className="truncate text-sm font-medium">{title}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </article>
  );
}

/**
 * Affiche d'un titre du catalogue TMDB, avec son statut calculé par le serveur (absent : ni en bibliothèque ni demandé)
 * et « Demander » quand le membre peut le demander.
 */
export function MediaPoster({ media, layout }: { media: MediaSummary; layout?: PosterLayout }) {
  const onRequest = useRequestAction(media);
  const watchUrl = useEmbyWatchUrl(media.embyItemId);
  return (
    <Poster
      title={media.title}
      subtitle={summaryMeta(media).join(' · ')}
      src={imageUrl(media.posterPath, 'poster') ?? undefined}
      status={media.status}
      progress={media.progress}
      to={{ type: media.type, id: media.tmdbId }}
      layout={layout}
      onRequest={onRequest}
      {...(watchUrl && { watchUrl })}
    />
  );
}

export function PosterSkeleton({ layout = 'rail' }: { layout?: PosterLayout }) {
  return (
    <div className={width[layout]} aria-hidden>
      <Skeleton className="aspect-2/3 rounded-poster" />
      <Skeleton className="mt-2 h-4 w-3/4" />
      <Skeleton className="mt-1.5 h-3 w-1/3" />
    </div>
  );
}
