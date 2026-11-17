import type { MediaType } from '@shared/media.ts';
import type {
  ApproveRequestInput,
  BatchRequestInput,
  BatchResult,
  RequestDetail,
  RequestPage,
  RequestView,
} from '@shared/requests.ts';
import type { MaskedSetting } from '@shared/settings.ts';
import type { ArrTestResult } from '@shared/setup.ts';
import type { RequestStatus } from '@shared/status.ts';
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingQuery } from '@/components/setup/queries';
import { apiGet, apiSend } from '@/lib/http';
import { arrName, failureReason, invalidateAfterRequest, requestKeys, requestTitle } from '@/lib/requests';

// File d'approbation : lectures et actions de l'approbateur (droit « gérer les demandes »).
// Clés et lectures communes aux demandes (compteurs, détail) : `lib/requests.ts`.

export const approvalTabs = ['pending', 'failed', 'history'] as const;
export type ApprovalTab = (typeof approvalTabs)[number];
export const approvalTabLabel: Record<ApprovalTab, string> = {
  pending: 'En attente',
  failed: 'Échecs',
  history: 'Historique',
};

/** Statuts de l'historique : décidées ou envoyées (l'API ne filtre que sur un statut à la fois). */
const historyStatuses: readonly RequestStatus[] = ['approved', 'declined', 'sent', 'available'];
export const inTab = (tab: ApprovalTab, request: RequestView) =>
  tab === 'history' ? historyStatuses.includes(request.status) : request.status === tab;

export const approvalListQuery = (tab: ApprovalTab, page = 1) =>
  queryOptions({
    queryKey: requestKeys.approvals(tab, page),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(page) });
      if (tab !== 'history') params.set('status', tab);
      return apiGet<RequestPage>(`/api/requests?${params}`, undefined, signal);
    },
  });

/** Choix de l'approbateur avant envoi, par demande ; ce qu'il ne change pas prend la valeur des réglages. */
export type SendChoice = ApproveRequestInput;

/** Profils de qualité et dossiers du service, avec la valeur par défaut des réglages. */
export interface SendOptions {
  service: string;
  profiles: ArrTestResult['qualityProfiles'];
  folders: ArrTestResult['rootFolders'];
  defaultProfileId: number;
  defaultFolder: string;
}

/**
 * Lu comme l'assistant (réglages, puis test de connexion avec la clé enregistrée) : seules ces deux routes
 * exposent les listes, et elles sont réservées au propriétaire. `null` : service pas encore configuré.
 */
export const sendOptionsQuery = (queryClient: QueryClient, type: MediaType) =>
  queryOptions({
    queryKey: ['send-options', type],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SendOptions | null> => {
      const key = type === 'movie' ? 'radarr' : 'sonarr';
      const stored: MaskedSetting<typeof key> | null = await queryClient.fetchQuery(settingQuery(key));
      if (!stored) return null;
      const { qualityProfiles, rootFolders } = await apiSend<ArrTestResult>('POST', `/api/setup/${key}/test`, {
        url: stored.url,
        apiKey: '',
      });
      return {
        service: arrName(type),
        profiles: qualityProfiles,
        folders: rootFolders,
        defaultProfileId: stored.qualityProfileId,
        defaultFolder: stored.rootFolderPath,
      };
    },
  });

/** Réservé au propriétaire (les listes viennent de routes qui lui sont réservées) ; `undefined` tant qu'elles chargent. */
export function useSendOptions(type: MediaType, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({ ...sendOptionsQuery(queryClient, type), enabled });
}

/** Nom du profil de qualité ; « Par défaut » tant que la liste n'est pas connue (pas propriétaire, ou en chargement). */
export const profileName = (options: SendOptions | null | undefined, id: number | null | undefined) =>
  (id == null ? undefined : options?.profiles.find((p) => p.id === id)?.name) ?? 'Par défaut';

/** Résultat affiché après une action : message d'une ligne par demande, vert ou rouge. */
export interface Feedback {
  tone: 'ok' | 'error';
  lines: string[];
}

/** Une approbation ou une relance peut réussir côté appli et échouer chez Radarr/Sonarr : la demande revient `failed`. */
export function sendOutcome(request: RequestDetail): Feedback {
  const title = requestTitle(request);
  const service = arrName(request.type);
  if (request.status !== 'failed') return { tone: 'ok', lines: [`${title} envoyée à ${service}.`] };
  const reason = failureReason(request);
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

/** Message lisible d'une erreur de l'API (déjà en français) ou d'une panne réseau. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Erreur inattendue du serveur');

/** Actions de l'approbateur ; chacune rafraîchit les listes et le compteur, qu'elle réussisse ou non. */
export function useApprovalActions() {
  const queryClient = useQueryClient();
  const onSettled = () => invalidateAfterRequest(queryClient);
  const approve = useMutation({
    mutationFn: ({ id, choice }: { id: number; choice?: SendChoice }) =>
      apiSend<RequestDetail>('POST', `/api/requests/${id}/approve`, choice ?? {}),
    onSettled,
  });
  const decline = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiSend<RequestDetail>('POST', `/api/requests/${id}/decline`, { reason }),
    onSettled,
  });
  const retry = useMutation({
    mutationFn: ({ id }: { id: number }) => apiSend<RequestDetail>('POST', `/api/requests/${id}/retry`),
    onSettled,
  });
  const batch = useMutation({
    mutationFn: (input: BatchRequestInput) => apiSend<BatchResult>('POST', '/api/requests/batch', input),
    onSettled,
  });
  return { approve, decline, retry, batch, busy: [approve, decline, retry, batch].some((m) => m.isPending) };
}
