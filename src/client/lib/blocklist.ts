import {
  BLOCKED_KEYWORDS_PATH,
  BLOCKED_TITLES_PATH,
  BLOCKLIST_PATH,
  type BlockedKeyword,
  type Blocklist,
  type BlockTitleInput,
  blockedTitlePath,
  KEYWORD_SEARCH_PATH,
} from '@shared/blocklist.ts';
import { DISCOVER_SETTINGS_PATH } from '@shared/catalogue.ts';
import type { MediaBlock, MediaKey } from '@shared/media.ts';
import type { Setting } from '@shared/settings.ts';
import { keepPreviousData, type QueryClient, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './http.ts';

// Seules définitions des requêtes des blocages (Réglages › Blocages, fiche) et du réglage « Masquer dans Découvrir ».

export const blocklistKeys = {
  all: ['blocklist'] as const,
  keywordSearch: (q: string) => ['blocklist', 'keywords', q] as const,
};

/** Titres et mots-clés bloqués (droit « Gérer les blocages »). */
export const blocklistQuery = queryOptions({
  queryKey: blocklistKeys.all,
  queryFn: ({ signal }) => apiGet<Blocklist>(BLOCKLIST_PATH, undefined, signal),
});

/** Mots-clés TMDB dont le nom correspond à `q` (vide : rien à chercher). */
export const keywordSearchQuery = (q: string) =>
  queryOptions({
    queryKey: blocklistKeys.keywordSearch(q),
    queryFn: ({ signal }) =>
      apiGet<BlockedKeyword[]>(`${KEYWORD_SEARCH_PATH}?${new URLSearchParams({ q })}`, undefined, signal),
    enabled: q.trim() !== '',
    placeholderData: keepPreviousData,
  });

/** Un blocage change Découvrir, la recherche et les fiches : relus avec la liste. */
function invalidateAfterBlock(client: QueryClient, saved: Blocklist) {
  client.setQueryData(blocklistQuery.queryKey, saved);
  for (const queryKey of [['discover'], ['media'], ['search']]) void client.invalidateQueries({ queryKey });
}

const useBlocklistMutation = <T>(send: (input: T) => Promise<Blocklist>) => {
  const client = useQueryClient();
  return useMutation({ mutationFn: send, onSuccess: (saved) => invalidateAfterBlock(client, saved) });
};

export const useBlockTitle = () =>
  useBlocklistMutation((input: BlockTitleInput) => apiSend<Blocklist>('POST', BLOCKED_TITLES_PATH, input));

export const useUnblockTitle = () =>
  useBlocklistMutation(({ type, tmdbId }: MediaKey) => apiSend<Blocklist>('DELETE', blockedTitlePath(type, tmdbId)));

/** Remplace la liste des mots-clés bloqués. */
export const useSetBlockedKeywords = () =>
  useBlocklistMutation((keywords: BlockedKeyword[]) => apiSend<Blocklist>('PUT', BLOCKED_KEYWORDS_PATH, { keywords }));

/** « Bloqué » ou « Bloqué (mot-clé « x ») » : pastille de la fiche, feuille de demande. */
export const blockLabel = (block: MediaBlock) =>
  block.by === 'title' ? 'Bloqué' : `Bloqué (mot-clé « ${block.keyword} »)`;

/** Réglage « Masquer dans Découvrir » (propriétaire). */
export const discoverSettingQuery = queryOptions({
  queryKey: ['settings', 'discover'],
  queryFn: ({ signal }) => apiGet<Setting<'discover'>>(DISCOVER_SETTINGS_PATH, undefined, signal),
});

export function useSaveDiscoverSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: Setting<'discover'>) => apiSend<Setting<'discover'>>('PUT', DISCOVER_SETTINGS_PATH, value),
    onSuccess: (saved) => {
      client.setQueryData(discoverSettingQuery.queryKey, saved);
      void client.invalidateQueries({ queryKey: ['discover'] });
    },
  });
}
