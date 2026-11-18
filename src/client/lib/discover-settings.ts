import { DISCOVER_LAYOUT_PATH } from '@shared/catalogue.ts';
import type { Setting, SettingInput } from '@shared/settings.ts';
import { TMDB_LOCALE_PATH } from '@shared/tmdb-locale.ts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './http.ts';

// Réglages de Découvrir et de la langue de TMDB (propriétaire) : seules définitions des requêtes.

export const discoverLayoutQuery = queryOptions({
  queryKey: ['settings', 'discover-layout'],
  queryFn: ({ signal }) => apiGet<Setting<'discoverLayout'>>(DISCOVER_LAYOUT_PATH, undefined, signal),
});

export const tmdbLocaleQuery = queryOptions({
  queryKey: ['settings', 'tmdb-locale'],
  queryFn: ({ signal }) => apiGet<Setting<'tmdbLocale'>>(TMDB_LOCALE_PATH, undefined, signal),
});

/** Enregistre l'ordre et l'état des rangées ; Découvrir est relu. */
export function useSaveDiscoverLayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: SettingInput<'discoverLayout'>) =>
      apiSend<Setting<'discoverLayout'>>('PUT', DISCOVER_LAYOUT_PATH, value),
    onSuccess: (saved) => {
      client.setQueryData(discoverLayoutQuery.queryKey, saved);
      void client.invalidateQueries({ queryKey: ['discover'] });
    },
  });
}

/**
 * Enregistre la langue et la région : titres, synopsis, genres, plateformes et sorties changent partout (listes,
 * fiches, recherche), donc tout ce que le navigateur a gardé est relu.
 */
export function useSaveTmdbLocale() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: SettingInput<'tmdbLocale'>) => apiSend<Setting<'tmdbLocale'>>('PUT', TMDB_LOCALE_PATH, value),
    onSuccess: (saved) => {
      client.setQueryData(tmdbLocaleQuery.queryKey, saved);
      void client.invalidateQueries();
    },
  });
}
