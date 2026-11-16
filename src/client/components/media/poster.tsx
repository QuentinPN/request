import { Film, Plus } from 'lucide-react';
import type { MediaStatus } from '../../../shared/status.ts';
import { Button } from '../ui/button.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { StatusPill } from './status-pill.tsx';

const canRequest = (status?: MediaStatus) => !status || status === 'partial' || status === 'declined';

/**
 * Affiche 2:3 : pastille de statut en haut à droite, « Demander » au survol et au focus,
 * toujours visible au toucher. L'élévation au focus suit --focus-scale (1 en mouvement réduit).
 */
export function Poster({
  title,
  year,
  src,
  status,
  href = '#',
  onRequest,
}: {
  title: string;
  year?: number;
  src?: string;
  status?: MediaStatus;
  href?: string;
  onRequest?: () => void;
}) {
  return (
    <article className="group/poster relative w-(--poster-w) shrink-0">
      <div className="relative aspect-2/3 overflow-hidden rounded-poster bg-(--media-base) ring-1 ring-border transition-[transform,box-shadow] duration-(--dur) ease-request group-focus-within/poster:scale-(--focus-scale) group-focus-within/poster:shadow-(--shadow-lift) group-hover/poster:scale-(--focus-scale) group-hover/poster:shadow-(--shadow-lift)">
        {src ? (
          <img src={src} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div aria-hidden className="grid size-full place-items-center text-(--on-media-2)/40">
            <Film className="size-8" strokeWidth={1.5} />
          </div>
        )}
        <a href={href} className="absolute inset-0 rounded-poster outline-none">
          <span className="sr-only">{year ? `${title} (${year})` : title}</span>
        </a>
        {status && <StatusPill status={status} onMedia className="pointer-events-none absolute top-2 right-2" />}
        {onRequest && canRequest(status) && (
          <div className="absolute inset-x-2 bottom-2 opacity-0 transition-opacity duration-(--dur) group-focus-within/poster:opacity-100 group-hover/poster:opacity-100 pointer-coarse:opacity-100">
            <Button size="sm" className="w-full" onClick={onRequest} aria-label={`Demander ${title}`}>
              <Plus data-icon="inline-start" />
              Demander
            </Button>
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <p className="truncate text-sm font-medium">{title}</p>
        {year && <p className="text-xs text-muted-foreground">{year}</p>}
      </div>
    </article>
  );
}

export function PosterSkeleton() {
  return (
    <div className="w-(--poster-w) shrink-0" aria-hidden>
      <Skeleton className="aspect-2/3 rounded-poster" />
      <Skeleton className="mt-2 h-4 w-3/4" />
      <Skeleton className="mt-1.5 h-3 w-1/3" />
    </div>
  );
}
