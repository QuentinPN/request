import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { MediaSummary, Paged } from '../../../shared/media.ts';
import { mediaKey, uniqueMedia } from '../../lib/catalogue.ts';
import { QueryState } from '../query-state.tsx';
import { ErrorState, Loading } from '../states.tsx';
import { Button } from '../ui/button.tsx';
import { MediaPoster, PosterSkeleton } from './poster.tsx';

const grid =
  'grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(var(--poster-w),1fr))] lg:gap-x-5';

export function PosterGridSkeleton({ count = 18 }: { count?: number }) {
  return (
    <Loading className={grid}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
        <PosterSkeleton key={i} layout="grid" />
      ))}
    </Loading>
  );
}

/** Grille d'affiches paginée, avec « Charger plus » tant que TMDB a d'autres pages. */
export function PosterGrid({
  query,
  empty,
}: {
  query: UseInfiniteQueryResult<InfiniteData<Paged<MediaSummary>>>;
  empty: { title: string; description?: string };
}) {
  const { hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  return (
    <QueryState
      query={query}
      skeleton={<PosterGridSkeleton />}
      errorMessage="Ces titres n’ont pas pu se charger."
      empty={empty}
      isEmpty={(data) => data.pages.every((page) => page.results.length === 0)}
    >
      {(data) => (
        <div className="space-y-10">
          <ul className={grid}>
            {uniqueMedia(data.pages.flatMap((page) => page.results)).map((media) => (
              <li key={mediaKey(media)}>
                <MediaPoster media={media} layout="grid" />
              </li>
            ))}
          </ul>
          {isFetchNextPageError ? (
            <ErrorState message="La page suivante n’a pas pu se charger." onRetry={() => void fetchNextPage()} />
          ) : (
            hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  size="lg"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage && <Loader2 data-icon="inline-start" className="motion-safe:animate-spin" />}
                  {isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
                </Button>
              </div>
            )
          )}
        </div>
      )}
    </QueryState>
  );
}
