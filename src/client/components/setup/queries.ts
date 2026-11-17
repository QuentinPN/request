import { API_KEYS_PATH, type ApiKey } from '@shared/api-keys.ts';
import { DISCORD_SETTINGS_PATH } from '@shared/discord.ts';
import type { MaskedSetting, SettingInput } from '@shared/settings.ts';
import type { SetupSection } from '@shared/setup.ts';
import { WEBHOOK_SETTINGS_PATH, type WebhookSettings } from '@shared/webhooks.ts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { embyLinkQuery } from '@/lib/emby';
import { ApiError, apiGet, apiSend } from '@/lib/http';
import { setupStateQuery } from '@/lib/session';

/** Réglage enregistré (secrets masqués), `null` s'il ne l'a jamais été. */
export const settingQuery = <K extends SetupSection>(key: K) =>
  queryOptions({
    queryKey: ['settings', key],
    queryFn: async (): Promise<MaskedSetting<K> | null> => {
      try {
        return await apiGet<MaskedSetting<K>>(`/api/settings/${key}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

/** Adresses des webhooks Radarr/Sonarr et leur jeton (propriétaire seulement). */
export const webhooksQuery = queryOptions({
  queryKey: ['settings', 'webhooks'],
  queryFn: ({ signal }) => apiGet<WebhookSettings>(WEBHOOK_SETTINGS_PATH, undefined, signal),
});

/** Notifications Discord : l'adresse du webhook est masquée (`{ set }`), le reste est lisible (propriétaire seulement). */
export const discordQuery = queryOptions({
  queryKey: ['settings', 'discord'],
  queryFn: ({ signal }) => apiGet<MaskedSetting<'discord'>>(DISCORD_SETTINGS_PATH, undefined, signal),
});

/** Clés d'API publiques, révoquées comprises, sans leur secret (propriétaire seulement). */
export const apiKeysQuery = queryOptions({
  queryKey: ['settings', 'api-keys'],
  queryFn: ({ signal }) => apiGet<ApiKey[]>(API_KEYS_PATH, undefined, signal),
});

/** Enregistre une section (le serveur refait le test de connexion), puis rafraîchit l'état de l'installation. */
export function useSaveSetting<K extends SetupSection>(key: K, onSaved: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: SettingInput<K>) => apiSend<MaskedSetting<K>>('PUT', `/api/settings/${key}`, value),
    onSuccess: async (saved) => {
      queryClient.setQueryData(settingQuery(key).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: setupStateQuery.queryKey });
      // L'adresse publique d'Emby se lit dans le lien « Regarder dans Emby » des affiches et des fiches.
      if (key === 'emby') await queryClient.invalidateQueries({ queryKey: embyLinkQuery.queryKey });
      onSaved();
    },
  });
}
