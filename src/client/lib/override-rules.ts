import { ARR_SERVERS_TEST_PATH, type ArrServer } from '@shared/arr-servers.ts';
import {
  OVERRIDE_RULES_ORDER_PATH,
  OVERRIDE_RULES_PATH,
  type OverrideRule,
  type OverrideRuleInput,
  overrideRulePath,
} from '@shared/override-rules.ts';
import type { ArrTestResult } from '@shared/setup.ts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './http.ts';

// Seules définitions des requêtes des règles de surcharge (Réglages › Règles de surcharge, propriétaire).

/** Règles, dans l'ordre (la première qui correspond l'emporte). */
export const overrideRulesQuery = queryOptions({
  queryKey: ['settings', 'override-rules'],
  queryFn: ({ signal }) => apiGet<OverrideRule[]>(OVERRIDE_RULES_PATH, undefined, signal),
});

/**
 * Profils, dossiers et étiquettes d'un serveur enregistré, pour les effets d'une règle : le test de connexion des
 * serveurs, avec la clé enregistrée (clé vide + `id`).
 */
export const arrServerChoicesQuery = (server: Pick<ArrServer, 'id' | 'type' | 'url'> | undefined) =>
  queryOptions({
    queryKey: ['settings', 'arr-server-choices', server?.id ?? null],
    enabled: server !== undefined,
    staleTime: 5 * 60_000,
    queryFn: () =>
      apiSend<ArrTestResult>('POST', ARR_SERVERS_TEST_PATH, {
        id: server?.id,
        type: server?.type,
        url: server?.url,
        apiKey: '',
      }),
  });

/** Règle et options d'envoi d'une demande (panneau d'approbation) se relisent après chaque changement. */
function useRulesChanged() {
  const client = useQueryClient();
  return (rules?: OverrideRule[]) => {
    if (rules) client.setQueryData(overrideRulesQuery.queryKey, rules);
    else void client.invalidateQueries({ queryKey: overrideRulesQuery.queryKey });
    void client.invalidateQueries({ queryKey: ['send-options'] });
  };
}

/** Ajoute (`id` absent) ou remplace une règle. */
export function useSaveOverrideRule() {
  const changed = useRulesChanged();
  return useMutation({
    mutationFn: ({ id, rule }: { id?: number | undefined; rule: OverrideRuleInput }) =>
      id === undefined
        ? apiSend<OverrideRule>('POST', OVERRIDE_RULES_PATH, rule)
        : apiSend<OverrideRule>('PUT', overrideRulePath(id), rule),
    onSuccess: () => changed(),
  });
}

export function useDeleteOverrideRule() {
  const changed = useRulesChanged();
  return useMutation({
    mutationFn: (id: number) => apiSend<void>('DELETE', overrideRulePath(id)),
    onSuccess: () => changed(),
  });
}

/** Nouvel ordre : tous les ids, du premier au dernier. */
export function useReorderOverrideRules() {
  const changed = useRulesChanged();
  return useMutation({
    mutationFn: (ids: number[]) => apiSend<OverrideRule[]>('PUT', OVERRIDE_RULES_ORDER_PATH, { ids }),
    onSuccess: (rules) => changed(rules),
  });
}
