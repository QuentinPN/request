import type { MediaType } from '@shared/media.ts';
import {
  type ApproveRequestInput,
  type BatchRequestInput,
  type BatchResult,
  REQUEST_BATCH_PATH,
  type RequestDetail,
  type RequestView,
  requestPath,
  type SendOptions,
  sendOptionsPath,
} from '@shared/requests.ts';
import type { RequestStatus } from '@shared/status.ts';
import { keepPreviousData, queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, isNotConfigured } from '@/lib/http';
import { invalidateAfterRequest, requestArrName, requestListQuery, requestTitle } from '@/lib/requests';

// File d'approbation : lectures et actions de l'approbateur (droit « gérer les demandes »).
// Clés et lectures communes aux demandes (liste, compteurs, détail) : `lib/requests.ts`.

export const approvalTabs = ['pending', 'failed', 'history'] as const;
export type ApprovalTab = (typeof approvalTabs)[number];
export const approvalTabLabel: Record<ApprovalTab, string> = {
  pending: 'En attente',
  failed: 'Échecs',
  history: 'Historique',
};

/** Statuts de l'historique : décidées ou envoyées. */
export const historyStatuses: readonly RequestStatus[] = ['approved', 'declined', 'sent', 'available'];

/** Statuts de chaque onglet, filtrés par le serveur : chaque page est pleine et compte juste. */
export const approvalTabStatuses: Record<ApprovalTab, readonly RequestStatus[]> = {
  pending: ['pending'],
  failed: ['failed'],
  history: historyStatuses,
};

export const approvalListQuery = (tab: ApprovalTab, page = 1) =>
  requestListQuery({ status: approvalTabStatuses[tab], page });

/** Choix de l'approbateur avant envoi, par demande ; ce qu'il ne change pas prend la valeur des réglages. */
export type SendChoice = ApproveRequestInput;
export type { SendOptions };

/** Ce dont dépendent les listes d'envoi : type, qualité (4K ou non) et serveur choisi (absent : celui par défaut). */
export interface SendTarget {
  type: MediaType;
  is4k: boolean;
  serverId?: number | undefined;
}

const targetKey = ({ type, is4k, serverId }: SendTarget) => [type, is4k, serverId ?? null] as const;

/** Serveur d'envoi d'une demande : choix de l'approbateur, sinon serveur déjà retenu, sinon celui par défaut. */
export const sendTargetOf = (request: RequestView, choice?: SendChoice): SendTarget => ({
  type: request.type,
  is4k: request.is4k,
  serverId: choice?.serverId ?? request.server?.id,
});

/** Serveurs, profils et dossiers (route des approbateurs) ; `null` : aucun serveur du type et de la qualité. */
export const sendOptionsQuery = (target: SendTarget) =>
  queryOptions({
    queryKey: ['send-options', ...targetKey(target)],
    staleTime: 5 * 60_000,
    // Changement de serveur : les listes du précédent restent affichées (désactivées) le temps de lire les nouvelles.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<SendOptions | null> => {
      const query = new URLSearchParams({ is4k: String(target.is4k) });
      if (target.serverId !== undefined) query.set('serverId', String(target.serverId));
      try {
        return await apiGet<SendOptions>(`${sendOptionsPath(target.type)}?${query}`, undefined, signal);
      } catch (error) {
        if (isNotConfigured(error)) return null;
        throw error;
      }
    },
  });

/**
 * Listes d'envoi de plusieurs demandes, lues une fois par couple serveur-qualité. `data` vaut `undefined` tant que les
 * listes chargent (ou si le service ne répond pas) : les réglages par défaut s'appliquent.
 */
export function useSendOptions(targets: readonly SendTarget[]) {
  const unique = [...new Map(targets.map((t) => [targetKey(t).join(':'), t])).values()];
  const results = useQueries({ queries: unique.map((t) => sendOptionsQuery(t)) });
  return (target: SendTarget) =>
    results[unique.findIndex((t) => targetKey(t).join(':') === targetKey(target).join(':'))];
}

/** Nom du profil de qualité ; « Par défaut » tant que la liste n'est pas connue (en chargement, service muet). */
export const profileName = (options: SendOptions | null | undefined, id: number | null | undefined) =>
  (id == null ? undefined : options?.qualityProfiles.find((p) => p.id === id)?.name) ?? 'Par défaut';

/** Résultat affiché après une action : message d'une ligne par demande, vert ou rouge. */
export interface Feedback {
  tone: 'ok' | 'error';
  lines: string[];
}

/** Une approbation ou une relance peut réussir côté appli et échouer chez Radarr/Sonarr : la demande revient `failed`. */
export function sendOutcome(request: RequestDetail): Feedback {
  const title = requestTitle(request);
  const service = requestArrName(request);
  if (request.status !== 'failed') return { tone: 'ok', lines: [`${title} envoyée à ${service}.`] };
  const reason = request.failureReason;
  return {
    tone: 'error',
    lines: [`${title} : ${service} n’a pas pu la recevoir${reason ? ` (${reason})` : ''}. Elle est dans Échecs.`],
  };
}

/** Action groupée : le serveur traite chaque demande à part, un refus métier n'arrête pas les autres. */
export function batchOutcome(
  { results }: BatchResult,
  titleOf: (id: number) => string,
  kind: 'approve' | 'decline',
): Feedback {
  const problems: string[] = [];
  let ok = 0;
  for (const result of results) {
    if (!result.ok) problems.push(`${titleOf(result.id)} : ${result.error}`);
    else if (kind === 'approve' && result.request.status === 'failed')
      problems.push(...sendOutcome(result.request).lines);
    else ok++;
  }
  const s = ok > 1 ? 's' : '';
  const done = ok === 0 ? [] : [`${ok} demande${s} ${kind === 'approve' ? `envoyée${s}` : `refusée${s}`}.`];
  return { tone: problems.length ? 'error' : 'ok', lines: [...done, ...problems] };
}

/** Refus d'une seule demande. */
export const declineOutcome = (request: RequestView): Feedback => ({
  tone: 'ok',
  lines: [`${requestTitle(request)} refusée.`],
});

/** Actions de l'approbateur ; chacune rafraîchit les listes et le compteur, qu'elle réussisse ou non. */
export function useApprovalActions() {
  const queryClient = useQueryClient();
  const onSettled = () => invalidateAfterRequest(queryClient);
  const approve = useMutation({
    mutationFn: ({ id, choice }: { id: number; choice?: SendChoice }) =>
      apiSend<RequestDetail>('POST', requestPath(id, 'approve'), choice ?? {}),
    onSettled,
  });
  const decline = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiSend<RequestDetail>('POST', requestPath(id, 'decline'), { reason }),
    onSettled,
  });
  const retry = useMutation({
    mutationFn: ({ id }: { id: number }) => apiSend<RequestDetail>('POST', requestPath(id, 'retry')),
    onSettled,
  });
  const batch = useMutation({
    mutationFn: (input: BatchRequestInput) => apiSend<BatchResult>('POST', REQUEST_BATCH_PATH, input),
    onSettled,
  });
  return { approve, decline, retry, batch, busy: [approve, decline, retry, batch].some((m) => m.isPending) };
}
