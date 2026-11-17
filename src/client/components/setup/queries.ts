import type { MaskedSetting, SettingInput } from '@shared/settings.ts';
import type { SetupSection } from '@shared/setup.ts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
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

/** Enregistre une section (le serveur refait le test de connexion), puis rafraîchit l'état de l'installation. */
export function useSaveSetting<K extends SetupSection>(key: K, onSaved: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: SettingInput<K>) => apiSend<MaskedSetting<K>>('PUT', `/api/settings/${key}`, value),
    onSuccess: async (saved) => {
      queryClient.setQueryData(settingQuery(key).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: setupStateQuery.queryKey });
      onSaved();
    },
  });
}
