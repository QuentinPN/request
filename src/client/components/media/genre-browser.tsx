import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { MediaType } from '../../../shared/media.ts';
import { discoverListQuery, genresQuery, mediaTypeNone, mediaTypePlural } from '../../lib/catalogue.ts';
import { Page } from '../page.tsx';
import { QueryState } from '../query-state.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { PosterGrid, PosterGridSkeleton } from './poster-grid.tsx';
import { ChipGroup, chipRow, FilterChip } from './title-parts.tsx';

function GenreResults({ type, genre }: { type: MediaType; genre: number }) {
  const query = useInfiniteQuery(discoverListQuery('genre', type, genre));
  return <PosterGrid query={query} empty={{ title: `${mediaTypeNone[type]} dans ce genre` }} />;
}

/** Pages Films et Séries : pilules de genre (premier genre par défaut) et grille paginée. */
export function GenreBrowser({ type, title, path }: { type: MediaType; title: string; path: '/films' | '/series' }) {
  const genres = useQuery(genresQuery(type));
  // Déjà validé par la route (`validateSearch`).
  const { genre } = useSearch({ strict: false });
  const navigate = useNavigate();

  return (
    <Page title={title}>
      <QueryState
        query={genres}
        skeleton={
          <div className="space-y-8">
            <div aria-hidden className={chipRow}>
              {[96, 72, 112, 88, 104, 80].map((w) => (
                <Skeleton key={w} className="h-9 shrink-0 rounded-pill" style={{ width: w }} />
              ))}
            </div>
            <PosterGridSkeleton />
          </div>
        }
        errorMessage={`Les genres de ${mediaTypePlural[type].toLowerCase()} n’ont pas pu se charger.`}
        empty={{ title: 'Aucun genre disponible' }}
        isEmpty={(data) => data.genres.length === 0}
      >
        {(data) => {
          const selected = data.genres.find((g) => g.id === genre) ?? data.genres[0];
          return (
            <div className="space-y-8">
              <ChipGroup label="Genres">
                {data.genres.map((g) => (
                  <FilterChip
                    key={g.id}
                    pressed={g.id === selected?.id}
                    onClick={() =>
                      void navigate({ to: path, search: { genre: g.id }, replace: true, resetScroll: false })
                    }
                  >
                    {g.name}
                  </FilterChip>
                ))}
              </ChipGroup>
              {selected && <GenreResults key={selected.id} type={type} genre={selected.id} />}
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
