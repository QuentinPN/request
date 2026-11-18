import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ISSUE_COUNTS_PATH,
  ISSUES_PATH,
  type IssueCommentInput,
  type IssueCounts,
  type IssueCreateInput,
  type IssueDetail,
  type IssuePage,
  type IssueStatus,
  type IssueView,
  issuePath,
} from '../../shared/issues.ts';
import type { MediaDetails } from '../../shared/media.ts';
import type { MediaStatus } from '../../shared/status.ts';
import { apiGet, apiSend } from './http.ts';

/** `?id=` de la page Signalements : le signalement ouvert (absent ou invalide : aucun). */
export const issueSearchSchema = z.object({ id: z.coerce.number().int().positive().optional().catch(undefined) });

// Seules définitions des requêtes des signalements (clés et adresses), lues par la feuille de la fiche, la page
// Signalements et la pastille de la navigation. Toutes les clés commencent par `issues`.

export const issueKeys = {
  all: ['issues'] as const,
  list: (status: IssueStatus, page: number) => ['issues', 'list', status, page] as const,
  counts: ['issues', 'counts'] as const,
  detail: (id: number) => ['issues', 'detail', id] as const,
};

/** Une page de signalements d'un statut, plus récents d'abord ; `totals` compte les deux statuts. */
export const issueListQuery = (status: IssueStatus, page = 1) =>
  queryOptions({
    queryKey: issueKeys.list(status, page),
    queryFn: ({ signal }) => apiGet<IssuePage>(`${ISSUES_PATH}?status=${status}&page=${page}`, undefined, signal),
  });

export const issueDetailQuery = (id: number) =>
  queryOptions({
    queryKey: issueKeys.detail(id),
    queryFn: ({ signal }) => apiGet<IssueDetail>(issuePath(id), undefined, signal),
  });

/** Pastille de la navigation : relue au retour sur l'onglet. */
export const issueCountsQuery = () =>
  queryOptions({
    queryKey: issueKeys.counts,
    queryFn: ({ signal }) => apiGet<IssueCounts>(ISSUE_COUNTS_PATH, undefined, signal),
    refetchOnWindowFocus: true,
  });

export function useCreateIssue() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueCreateInput) => apiSend<IssueDetail>('POST', ISSUES_PATH, input),
    onSuccess: () => client.invalidateQueries({ queryKey: issueKeys.all }),
  });
}

/** Commenter, résoudre, rouvrir : le signalement renvoyé remplace son détail, les listes et la pastille sont relues. */
function useIssueAction<TVariables>(send: (variables: TVariables) => Promise<IssueDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (issue) => {
      client.setQueryData(issueKeys.detail(issue.id), issue);
      return client.invalidateQueries({ queryKey: issueKeys.all });
    },
  });
}

export const useIssueComment = () =>
  useIssueAction(({ id, ...input }: { id: number } & IssueCommentInput) =>
    apiSend<IssueDetail>('POST', issuePath(id, 'comments'), input),
  );
export const useResolveIssue = () =>
  useIssueAction((id: number) => apiSend<IssueDetail>('POST', issuePath(id, 'resolve')));
export const useReopenIssue = () =>
  useIssueAction((id: number) => apiSend<IssueDetail>('POST', issuePath(id, 'reopen')));

export const issueStatusTabs = ['open', 'resolved'] as const satisfies readonly IssueStatus[];
export const issueTabLabel: Record<IssueStatus, string> = { open: 'Ouverts', resolved: 'Résolus' };

const inLibrary = (status?: MediaStatus) => status === 'available' || status === 'partial';

/**
 * Un problème se signale sur un titre présent dans la bibliothèque : disponible, partiel, ou (le statut affiché
 * laisse alors la place à « demandé ») lié à Emby ou avec une saison présente. Le serveur reste juge.
 */
export const canReport = ({ status, embyItemId, seasons }: Pick<MediaDetails, 'status' | 'embyItemId' | 'seasons'>) =>
  inLibrary(status) || !!embyItemId || seasons.some((s) => inLibrary(s.status));

/** « Saison 2 · épisode 5 », « Saison 2 » ; `null` pour tout le titre. */
export function issueScope({ seasonNumber, episodeNumber }: Pick<IssueView, 'seasonNumber' | 'episodeNumber'>) {
  if (seasonNumber === null) return null;
  return episodeNumber === null ? `Saison ${seasonNumber}` : `Saison ${seasonNumber} · épisode ${episodeNumber}`;
}

/** Nom du titre ; une formule neutre quand TMDB ne répond pas. */
export const issueTitle = (issue: Pick<IssueView, 'title' | 'media'>) =>
  issue.title ?? `Titre TMDB n° ${issue.media.tmdbId}`;
