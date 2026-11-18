import { API_KEYS_PATH, type ApiKey } from '@shared/api-keys.ts';
import { ARR_SERVERS_PATH, type ArrServer, type ArrServerInput } from '@shared/arr-servers.ts';
import { DISCORD_SETTINGS_PATH } from '@shared/discord.ts';
import { SMTP_SETTINGS_PATH } from '@shared/notifications.ts';
import type { MaskedSetting, SettingInput } from '@shared/settings.ts';
import { type SettingSection, settingPath } from '@shared/setup.ts';
import { TRAKT_SETTINGS_PATH } from '@shared/watchlist.ts';
import { WEBHOOK_SETTINGS_PATH, type WebhookSettings } from '@shared/webhooks.ts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, isNotFound } from '@/lib/http';
import { watchLinkQuery } from '@/lib/media-server';
import { setupStateQuery } from '@/lib/session';

/** Réglage enregistré (secrets masqués), `null` s'il ne l'a jamais été (404). */
async function storedSetting<K extends SettingSection | 'smtp'>(path: string): Promise<MaskedSetting<K> | null> {
  try {
    return await apiGet<MaskedSetting<K>>(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Réglage d'une section de l'assistant. */
export const settingQuery = <K extends SettingSection>(key: K) =>
  queryOptions({ queryKey: ['settings', key], queryFn: () => storedSetting<K>(settingPath(key)) });

/** Réglage du courriel (SMTP), `null` tant qu'il n'est pas configuré. */
export const smtpQuery = queryOptions({
  queryKey: ['settings', 'smtp'],
  queryFn: () => storedSetting<'smtp'>(SMTP_SETTINGS_PATH),
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

/** Client ID Trakt : masqué (`{ set }`), jamais renvoyé (propriétaire seulement). */
export const traktQuery = queryOptions({
  queryKey: ['settings', 'trakt'],
  queryFn: ({ signal }) => apiGet<MaskedSetting<'trakt'>>(TRAKT_SETTINGS_PATH, undefined, signal),
});

/** Clés d'API publiques, révoquées comprises, sans leur secret (propriétaire seulement). */
export const apiKeysQuery = queryOptions({
  queryKey: ['settings', 'api-keys'],
  queryFn: ({ signal }) => apiGet<ApiKey[]>(API_KEYS_PATH, undefined, signal),
});

/** Enregistre une section (le serveur refait le test de connexion), puis rafraîchit l'état de l'installation. */
export function useSaveSetting<K extends SettingSection>(key: K, onSaved: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: SettingInput<K>) => apiSend<MaskedSetting<K>>('PUT', settingPath(key), value),
    onSuccess: async (saved) => {
      queryClient.setQueryData(settingQuery(key).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: setupStateQuery.queryKey });
      // Type et adresse publique du serveur multimédia : le lien « Regarder dans… » des affiches et des fiches.
      if (key === 'mediaServer') await queryClient.invalidateQueries({ queryKey: watchLinkQuery.queryKey });
      onSaved();
    },
  });
}

/** Serveurs Radarr et Sonarr, clés masquées (propriétaire seulement). */
export const arrServersQuery = queryOptions({
  queryKey: ['settings', 'arr-servers'],
  queryFn: ({ signal }) => apiGet<ArrServer[]>(ARR_SERVERS_PATH, undefined, signal),
});

/** Après un changement de serveur : la liste, l'état de l'installation et les adresses des webhooks (une par serveur). */
function useArrServersChanged() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [arrServersQuery, setupStateQuery, webhooksQuery].map((q) =>
        queryClient.invalidateQueries({ queryKey: q.queryKey }),
      ),
    );
}

/** Ajoute (`id` absent) ou modifie un serveur ; le serveur refait le test de connexion avant d'enregistrer. */
export function useSaveArrServer(id: number | undefined, onSaved: (server: ArrServer) => void) {
  const changed = useArrServersChanged();
  return useMutation({
    mutationFn: (value: ArrServerInput) =>
      id === undefined
        ? apiSend<ArrServer>('POST', ARR_SERVERS_PATH, value)
        : apiSend<ArrServer>('PUT', `${ARR_SERVERS_PATH}/${id}`, value),
    onSuccess: async (saved) => {
      await changed();
      onSaved(saved);
    },
  });
}

export function useDeleteArrServer(onDeleted: () => void) {
  const changed = useArrServersChanged();
  return useMutation({
    mutationFn: (id: number) => apiSend<void>('DELETE', `${ARR_SERVERS_PATH}/${id}`),
    onSuccess: async () => {
      await changed();
      onDeleted();
    },
  });
}
