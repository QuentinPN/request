import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MediaKey } from '../../shared/media.ts';
import {
  type ImportSource,
  type InWatchlist,
  importPath,
  inWatchlistSchema,
  type LetterboxdImportInput,
  type TraktImportInput,
  WATCHLIST_PATH,
  type WatchlistImportResult,
  watchlistItemPath,
  watchlistPageSchema,
} from '../../shared/watchlist.ts';
import { apiGet, apiSend, nextPageParam } from './http.ts';

// Seules définitions des requêtes de la liste de souhaits (clés et adresses). Toutes les clés commencent par
// `watchlist` : `invalidateQueries({ queryKey: watchlistKeys.all })` suffit.

export const watchlistKeys = {
  all: ['watchlist'] as const,
  list: ['watchlist', 'list'] as const,
  has: ({ type, tmdbId }: MediaKey) => ['watchlist', 'has', type, tmdbId] as const,
};

/** « Ma liste », page après page (« Charger plus »). */
export const watchlistQuery = () =>
  infiniteQueryOptions({
    queryKey: watchlistKeys.list,
    queryFn: ({ pageParam, signal }) => apiGet(`${WATCHLIST_PATH}?page=${pageParam}`, watchlistPageSchema, signal),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
  });

/** Le titre est-il dans la liste du membre (bouton de la fiche). */
export const inWatchlistQuery = (item: MediaKey) =>
  queryOptions({
    queryKey: watchlistKeys.has(item),
    queryFn: ({ signal }) => apiGet(watchlistItemPath(item.type, item.tmdbId), inWatchlistSchema, signal),
  });

/** Ajoute le titre à la liste (`true`) ou l'en retire (`false`), puis met le bouton et « Ma liste » à jour. */
export function useSetInWatchlist(item: MediaKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (inList: boolean) =>
      inList
        ? apiSend<InWatchlist>('POST', WATCHLIST_PATH, { type: item.type, tmdbId: item.tmdbId })
        : apiSend<InWatchlist>('DELETE', watchlistItemPath(item.type, item.tmdbId)),
    onSuccess: (result) => {
      client.setQueryData(watchlistKeys.has(item), result);
      void client.invalidateQueries({ queryKey: watchlistKeys.list });
    },
  });
}

/** Aperçu (`dryRun`, rien n'est écrit) ou import d'une liste Trakt ou d'un fichier Letterboxd. */
export const importWatchlist = (
  source: ImportSource,
  input: TraktImportInput | LetterboxdImportInput,
  dryRun: boolean,
) => apiSend<WatchlistImportResult>('POST', `${importPath(source)}${dryRun ? '?dryRun=1' : ''}`, input);
