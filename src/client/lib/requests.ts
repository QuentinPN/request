import { type QueryClient, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MediaKey, MediaType } from '../../shared/media.ts';
import type {
  CreateRequestInput,
  RequestCounts,
  RequestDetail,
  RequestPage,
  RequestQuota,
  RequestView,
} from '../../shared/requests.ts';
import {
  type ActiveRequestStatus,
  activeRequestStatuses,
  type MediaStatus,
  type RequestStatus,
} from '../../shared/status.ts';
import { mediaTypeLabel } from './catalogue.ts';
import { apiGet, apiSend } from './http.ts';
import { downloadPercent } from './status.ts';

// Seules définitions des requêtes des demandes (clés et adresses), lues par la feuille, Mes demandes, Découvrir et
// la fiche. Toutes les clés commencent par `requests` : `invalidateQueries({ queryKey: requestKeys.all })` suffit.

export const requestKeys = {
  all: ['requests'] as const,
  mine: ['requests', 'mine'] as const,
  quota: ['requests', 'quota'] as const,
  counts: ['requests', 'counts'] as const,
  detail: (id: number) => ['requests', 'detail', id] as const,
  /** File d'approbation : un onglet (statut ou historique) et sa page. */
  approvals: (tab: string, page: number) => ['requests', 'approvals', tab, page] as const,
};

/** Plafond de pages lues pour « toutes mes demandes » (20 par page) : quelques dizaines par membre en pratique. */
const MINE_MAX_PAGES = 10;

/**
 * Toutes les demandes du membre connecté, de la plus récente à la plus ancienne. L'API ne filtre que sur un statut à
 * la fois, sans total ni filtre par titre : la liste complète est lue ici une fois, puis filtrée et comptée côté
 * client (Mes demandes, bande de Découvrir, suivi sur la fiche).
 */
async function fetchAllMine(signal: AbortSignal): Promise<RequestView[]> {
  const results: RequestView[] = [];
  for (let page = 1; page <= MINE_MAX_PAGES; page++) {
    const data = await apiGet<RequestPage>(`/api/requests?mine=true&page=${page}`, undefined, signal);
    results.push(...data.results);
    if (page >= data.totalPages) break;
  }
  return results;
}

export const myRequestsQuery = () =>
  queryOptions({ queryKey: requestKeys.mine, queryFn: ({ signal }) => fetchAllMine(signal) });

export const requestQuotaQuery = () =>
  queryOptions({
    queryKey: requestKeys.quota,
    queryFn: ({ signal }) => apiGet<RequestQuota>('/api/requests/quota', undefined, signal),
  });

/** Compteurs (navigation, bande de Découvrir) : relus au retour sur l'onglet, l'approbateur peut avoir attendu longtemps. */
export const requestCountsQuery = () =>
  queryOptions({
    queryKey: requestKeys.counts,
    queryFn: ({ signal }) => apiGet<RequestCounts>('/api/requests/counts', undefined, signal),
    refetchOnWindowFocus: true,
  });

export const requestDetailQuery = (id: number) =>
  queryOptions({
    queryKey: requestKeys.detail(id),
    queryFn: ({ signal }) => apiGet<RequestDetail>(`/api/requests/${id}`, undefined, signal),
  });

/** Dernière demande du membre pour ce titre (la liste est triée de la plus récente à la plus ancienne). */
export const latestRequestFor = (requests: RequestView[], { type, tmdbId }: MediaKey) =>
  requests.find((r) => r.type === type && r.tmdbId === tmdbId);

/** Raison de l'échec d'un envoi : le détail du dernier événement `failed`. */
export const failureReason = (request: RequestDetail): string | null =>
  request.events.findLast((event) => event.type === 'failed')?.detail ?? null;

/** Une demande change le statut des titres : catalogue, fiches et recherche sont relus avec les demandes. */
export function invalidateAfterRequest(client: QueryClient) {
  for (const queryKey of [requestKeys.all, ['discover'], ['media'], ['search']])
    void client.invalidateQueries({ queryKey });
}

export function useCreateRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRequestInput) => apiSend<RequestDetail>('POST', '/api/requests', input),
    onSuccess: () => invalidateAfterRequest(client),
  });
}

export function useCancelRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend<RequestDetail>('POST', `/api/requests/${id}/cancel`),
    onSuccess: () => invalidateAfterRequest(client),
  });
}

/** Service qui reçoit la demande : Radarr pour un film, Sonarr pour une série. */
export const arrName = (type: MediaType) => (type === 'movie' ? 'Radarr' : 'Sonarr');

export const requestStatusLabel: Record<RequestStatus, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  declined: 'Refusée',
  cancelled: 'Annulée',
  sent: 'Envoyée',
  failed: 'Échec',
  available: 'Disponible',
};

// --- Progression d'une demande (barre en quatre étapes, pastille, frise) ---

export const requestSteps = ['Demandé', 'Approuvé', 'Téléchargé', 'Dans Emby'] as const;
export type StepState = 'done' | 'current' | 'failed' | 'todo';

export interface RequestProgress {
  /** Une valeur par étape de `requestSteps`. */
  steps: StepState[];
  /** Teinte de la pastille, empruntée aux statuts des titres. */
  tone: MediaStatus;
  /** Texte de la pastille. */
  label: string;
  /** Ce qui se passe maintenant, en une phrase. */
  detail: string;
  /** Avancement du téléchargement (0 à 100) quand l'étape « Téléchargé » est en cours. */
  percent?: number;
}

/** Demande en cours (bande de Découvrir, filtre « En cours »). */
export const isActiveRequest = (status: RequestView['status']): status is ActiveRequestStatus =>
  (activeRequestStatuses as readonly string[]).includes(status);

const D = 'done';
const C = 'current';
const T = 'todo';
const F = 'failed';

/**
 * Seule traduction d'une demande (statut + statut du titre) en étapes : l'étape `current` est la dernière atteinte,
 * encore en cours. Refus et échec marquent l'approbation en rouge ; une demande annulée s'arrête à « Demandé ».
 */
export function requestProgress(request: Pick<RequestView, 'status' | 'media' | 'type'>): RequestProgress {
  const arr = arrName(request.type);
  const media = request.media;
  switch (request.status) {
    case 'pending':
      return {
        steps: [C, T, T, T],
        tone: 'pending',
        label: requestStatusLabel.pending,
        detail: 'En attente d’approbation',
      };
    case 'approved':
      return {
        steps: [D, C, T, T],
        tone: 'requested',
        label: requestStatusLabel.approved,
        detail: `Envoi à ${arr} en cours`,
      };
    case 'failed':
      return {
        steps: [D, F, T, T],
        tone: 'declined',
        label: requestStatusLabel.failed,
        detail: `L’envoi à ${arr} a échoué`,
      };
    case 'declined':
      return {
        steps: [D, F, T, T],
        tone: 'declined',
        label: requestStatusLabel.declined,
        detail: 'Refusée par un administrateur',
      };
    case 'cancelled':
      return {
        steps: [D, T, T, T],
        tone: 'pending',
        label: requestStatusLabel.cancelled,
        detail: 'Vous avez annulé cette demande',
      };
    case 'available':
      return {
        steps: [D, D, D, D],
        tone: 'available',
        label: requestStatusLabel.available,
        detail: 'Disponible dans Emby',
      };
    case 'sent': {
      if (media?.status === 'available')
        return {
          steps: [D, D, D, D],
          tone: 'available',
          label: requestStatusLabel.available,
          detail: 'Disponible dans Emby',
        };
      if (media?.status === 'downloading') {
        const percent = media ? downloadPercent(media) : undefined;
        return {
          steps: [D, D, C, T],
          tone: 'downloading',
          label: percent === undefined ? 'Téléchargement' : `${percent} %`,
          detail: percent === undefined ? 'Téléchargement en cours' : `Téléchargement à ${percent} %`,
          percent,
        };
      }
      return {
        steps: [D, C, T, T],
        tone: 'requested',
        label: requestStatusLabel.approved,
        detail: `${arr} cherche une source`,
      };
    }
  }
}

// --- Libellés ---

/** « saison 1 », « saisons 1 et 2 », « saisons 1, 2 et 4 ». */
export function seasonsLabel(seasons: number[]): string {
  if (seasons.length === 0) return '';
  if (seasons.length === 1) return `saison ${seasons[0]}`;
  return `saisons ${seasons.slice(0, -1).join(', ')} et ${seasons.at(-1)}`;
}

/** Titre d'une demande ; le numéro tient lieu de titre tant que le catalogue ne l'a pas résolu. */
export const requestTitle = (request: Pick<RequestView, 'id' | 'media'>) =>
  request.media?.title ?? `Demande n° ${request.id}`;

/** « Film · 2024 » ou « Série · saisons 1 et 2 ». */
export const requestMeta = ({ type, media, seasons }: Pick<RequestView, 'type' | 'media' | 'seasons'>) =>
  [mediaTypeLabel[type], type === 'tv' && seasons.length > 0 ? seasonsLabel(seasons) : media?.year].filter(Boolean);

/** Titre court d'une demande : « Shōgun · S1 », « Arcane · S1-2 » (cartes de Découvrir). */
export function requestShortTitle(request: Pick<RequestView, 'id' | 'seasons' | 'media' | 'type'>): string {
  const title = requestTitle(request);
  const { seasons } = request;
  if (request.type !== 'tv' || seasons.length === 0) return title;
  const contiguous = seasons.every((n, i) => i === 0 || n === (seasons[i - 1] ?? 0) + 1);
  const range =
    seasons.length === 1
      ? `S${seasons[0]}`
      : contiguous
        ? `S${seasons[0]}-${seasons.at(-1)}`
        : seasons.map((n) => `S${n}`).join(', ');
  return `${title} · ${range}`;
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** « 13 nov. » (année courante) ou « 13 nov. 2025 ». */
export function formatDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return (date.getFullYear() === now.getFullYear() ? dayFormat : dayYearFormat).format(date);
}

/** « 13 nov. à 20 h 02 ». */
export function formatDateTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${formatDay(iso, now)} à ${date.getHours()} h ${minutes}`;
}

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto', style: 'short' });
const UNITS = [
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
] as const;

/** « il y a 12 min », « il y a 2 h », « hier », puis la date au-delà d'une semaine. */
export function formatWhen(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < 60_000) return 'à l’instant';
  if (elapsed >= 7 * 86_400_000) return formatDay(iso, new Date(now));
  const [unit, size] = UNITS.findLast(([, size]) => elapsed >= size) ?? UNITS[0];
  return relative.format(-Math.floor(elapsed / size), unit);
}
