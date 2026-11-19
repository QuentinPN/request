import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MediaKey } from '../../shared/media.ts';
import {
  type AddedToWatchlist,
  type AutoRequestSetting,
  autoRequestSettingSchema,
  type ImportSource,
  importPath,
  inWatchlistSchema,
  type LetterboxdImportInput,
  type TraktImportInput,
  WATCHLIST_AUTO_REQUEST_PATH,
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
  autoRequest: ['watchlist', 'auto-request'] as const,
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

/** Option « demander automatiquement ce que j'ajoute » (réservée aux membres qui en ont le droit : à ne lire que pour eux). */
export const autoRequestQuery = queryOptions({
  queryKey: watchlistKeys.autoRequest,
  queryFn: ({ signal }) => apiGet(WATCHLIST_AUTO_REQUEST_PATH, autoRequestSettingSchema, signal),
});

export function useSetAutoRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => apiSend<AutoRequestSetting>('PUT', WATCHLIST_AUTO_REQUEST_PATH, { enabled }),
    onSuccess: (setting) => client.setQueryData(watchlistKeys.autoRequest, setting),
  });
}

/**
 * Ajoute le titre à la liste (`true`) ou l'en retire (`false`), puis met le bouton et « Ma liste » à jour. L'ajout
 * renvoie le sort de la demande automatique (`autoRequest`) quand l'option du membre est active.
 */
export function useSetInWatchlist(item: MediaKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (inList: boolean) =>
      inList
        ? apiSend<AddedToWatchlist>('POST', WATCHLIST_PATH, { type: item.type, tmdbId: item.tmdbId })
        : apiSend<AddedToWatchlist>('DELETE', watchlistItemPath(item.type, item.tmdbId)),
    onSuccess: ({ inList }) => {
      client.setQueryData(watchlistKeys.has(item), { inList });
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
