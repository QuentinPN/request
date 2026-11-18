import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { BrowseFilters } from '../../../shared/catalogue.ts';
import type { MediaType } from '../../../shared/media.ts';
import { browseQuery, browseSearchOf, mediaTypeNone, parseBrowseFilters } from '../../lib/catalogue.ts';
import { Page } from '../page.tsx';
import { BrowseFilterBar, browseFiltersFor } from './browse-filters.tsx';
import { PosterGrid } from './poster-grid.tsx';

function BrowseResults({ type, filters }: { type: MediaType; filters: BrowseFilters }) {
  const query = useInfiniteQuery(browseQuery(type, filters));
  return (
    <PosterGrid
      query={query}
      empty={{
        title: `${mediaTypeNone[type]} pour ces filtres`,
        description: 'Élargissez la recherche ou réinitialisez les filtres.',
      }}
    />
  );
}

/** Pages Films et Séries : filtres (genres, année, note, durée, langue, plateforme, tri) dans l'adresse et grille paginée. */
export function TitleBrowser({ type, title, path }: { type: MediaType; title: string; path: '/films' | '/series' }) {
  // Déjà validé par la route (`validateSearch`).
  const filters = browseFiltersFor(type, parseBrowseFilters(useSearch({ strict: false })));
  const navigate = useNavigate();

  return (
    <Page title={title}>
      <div className="space-y-8">
        <BrowseFilterBar
          type={type}
          filters={filters}
          onChange={(next) =>
            void navigate({ to: path, search: browseSearchOf(next), replace: true, resetScroll: false })
          }
        />
        {/* Nouvelle liste (et nouveau défilement) à chaque changement de filtre. */}
        <BrowseResults key={JSON.stringify(filters)} type={type} filters={filters} />
      </div>
    </Page>
  );
}
