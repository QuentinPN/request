import { z } from 'zod';
import type { ArrServerSummary } from './arr-servers.ts';
import { type MediaSummary, type MediaType, mediaTypeSchema, type Paged, type Season } from './media.ts';
import { profileId, rootFolderPath, type SeriesType, seriesTypes } from './settings.ts';
import type { ArrTestResult } from './setup.ts';
import { type RequestEventType, type RequestStatus, requestStatusSchema } from './status.ts';

// --- Saisons demandables ---

/**
 * Jour courant (`AAAA-MM-JJ`, UTC) pour comparer aux dates de diffusion TMDB : même base côté serveur (règle) et
 * côté feuille de demande (affichage), pour qu'une saison proposée ne soit jamais refusée.
 */
export const isoDay = (at: number | Date = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Saison diffusée à `day` (`isoDay`) : au moins un épisode et une date de diffusion passée. */
export const isAiredSeason = (season: Pick<Season, 'episodeCount' | 'airDate'>, day: string) =>
  season.episodeCount > 0 && !!season.airDate && season.airDate <= day;

// --- Entrées (validées côté serveur, réutilisables par les formulaires) ---

const tmdbId = z.number().int().positive();
const seasonNumber = z.number().int().min(0);
const requestId = z.number().int().positive();

/** Demande en 4K : envoyée à un serveur 4K, statut 4K à part (`media.status_4k`). */
const is4k = z.boolean().default(false);

/**
 * Hors quota : la demande ne compte pas dans le quota du membre (gestionnaires seulement, à la demande et à
 * l'approbation).
 */
const quotaExempt = z.boolean().optional();

/**
 * Champs communs aux films et aux séries : `forUserId` demande à la place de ce membre (droit « Demander pour un
 * autre » : la demande est à lui, quota et notifications compris), `quotaExempt` la met hors quota.
 */
const requestOptions = { is4k, forUserId: z.string().min(1).optional(), quotaExempt };

/** Film, ou saisons d'une série (`'all'`, par défaut : toutes les saisons diffusées encore manquantes). */
export const createRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), tmdbId, ...requestOptions }),
  z.strictObject({
    type: z.literal('tv'),
    tmdbId,
    seasons: z.union([z.literal('all'), z.array(seasonNumber).min(1).max(100)]).default('all'),
    ...requestOptions,
  }),
]);
export type CreateRequestInput = z.input<typeof createRequestSchema>;

export const DECLINE_REASON_MAX = 500;
const declineReason = z
  .string()
  .trim()
  .min(1, 'Motif requis')
  .max(DECLINE_REASON_MAX, `Motif trop long (${DECLINE_REASON_MAX} caractères au plus)`);

export const declineRequestSchema = z.object({ reason: declineReason });

/**
 * Choix de l'approbateur avant envoi ; chaque champ absent prend la valeur du serveur. `serverId` : serveur du bon type
 * et de la bonne qualité (4K ou non), par défaut celui de la demande, sinon le serveur par défaut.
 */
export const approveRequestSchema = z.object({
  serverId: z.number().int().positive().optional(),
  qualityProfileId: profileId.optional(),
  rootFolderPath: rootFolderPath.optional(),
  seriesType: z.enum(seriesTypes).optional(),
  quotaExempt,
});
export type ApproveRequestInput = z.input<typeof approveRequestSchema>;

export const REQUEST_BATCH_MAX = 100;
const batchIds = z.array(requestId).min(1).max(REQUEST_BATCH_MAX);
export const batchRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), ids: batchIds }),
  z.object({ action: z.literal('decline'), ids: batchIds, reason: declineReason }),
]);
export type BatchRequestInput = z.input<typeof batchRequestSchema>;

export const REQUESTS_PAGE_SIZE = 20;
/** Plusieurs statuts : séparés par des virgules (`status=pending,failed`), jamais en paramètre répété. */
const statusList = z
  .string()
  .transform((value) => [...new Set(value.split(','))])
  .pipe(z.array(requestStatusSchema).min(1));
/**
 * `?status=&type=&tmdbId=&mine=&page=` ; un membre sans droit d'approbation ne voit que ses demandes, quel que soit
 * `mine`. `tmdbId` ne va pas sans `type` (un même id TMDB désigne un film et une série différents).
 */
export const requestListQuerySchema = z
  .object({
    status: statusList.optional(),
    type: mediaTypeSchema.optional(),
    tmdbId: z.coerce.number().pipe(tmdbId).optional(),
    mine: z.stringbool().default(false),
    page: z.coerce.number().int().positive().default(1),
  })
  .refine((query) => query.tmdbId === undefined || query.type !== undefined, { path: ['type'] });
/** Filtres de la liste, côté client : `status` en tableau, sérialisé par `requestListParams`. */
export interface RequestListFilter {
  status?: readonly RequestStatus[];
  type?: MediaType;
  tmdbId?: number;
  mine?: boolean;
  page?: number;
}

/** Seule écriture de la requête de la liste : `?status=a,b&type=&tmdbId=&mine=&page=`. */
export function requestListParams({ status, type, tmdbId, mine, page }: RequestListFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (status?.length) params.set('status', status.join(','));
  if (type) params.set('type', type);
  if (tmdbId !== undefined) params.set('tmdbId', String(tmdbId));
  if (mine) params.set('mine', 'true');
  if (page !== undefined) params.set('page', String(page));
  return params;
}

export const requestIdParamsSchema = z.object({ id: z.coerce.number().pipe(requestId) });

// --- Réponses ---

export interface RequestPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface RequestView {
  id: number;
  type: MediaType;
  tmdbId: number;
  status: RequestStatus;
  /** Saisons demandées (séries), triées ; vide pour un film. */
  seasons: number[];
  /** Membre à qui la demande appartient (quota, notifications). */
  requester: RequestPerson;
  /** Gestionnaire qui l'a faite à sa place (« Demandée par X pour Y ») ; `null` : le membre lui-même. */
  createdBy: RequestPerson | null;
  /** Hors quota : ne compte pas dans le quota du membre. */
  quotaExempt: boolean;
  /** Qui a approuvé ou refusé ; `null` tant que la demande est en attente. */
  decidedBy: RequestPerson | null;
  declineReason: string | null;
  qualityProfileId: number | null;
  rootFolder: string | null;
  seriesType: SeriesType | null;
  is4k: boolean;
  /** Serveur Radarr/Sonarr choisi à l'approbation ; `null` = serveur par défaut au moment de l'envoi. */
  server: { id: number; name: string } | null;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** Résumé TMDB (titre, affiche) ; `null` si TMDB ne répond pas. */
  media: MediaSummary | null;
  /** Raison du dernier échec d'envoi (frise) ; `null` sauf pour une demande en échec. */
  failureReason: string | null;
}

export interface RequestEventView {
  id: number;
  type: RequestEventType;
  actor: RequestPerson | null;
  detail: string | null;
  createdAt: string;
}

/** Demande avec sa frise, dans l'ordre chronologique. */
export interface RequestDetail extends RequestView {
  events: RequestEventView[];
}

/**
 * Page de demandes, avec le nombre de demandes par statut sur tout le périmètre (les siennes, ou toutes pour un
 * approbateur, restreint au titre si `type`/`tmdbId`), quel que soit le filtre `status` : de quoi compter chaque onglet.
 */
export interface RequestPage extends Paged<RequestView> {
  totals: Record<RequestStatus, number>;
}

/**
 * Serveurs du type et de la qualité de la demande, puis profils de qualité et dossiers racines de l'un d'eux (`serverId`,
 * le serveur par défaut sauf choix), avec ses valeurs par défaut : ce qu'un approbateur peut choisir avant l'envoi (ni
 * adresse, ni clé).
 */
export interface SendOptions {
  servers: ArrServerSummary[];
  serverId: number;
  qualityProfiles: ArrTestResult['qualityProfiles'];
  rootFolders: ArrTestResult['rootFolders'];
  defaultProfileId: number;
  defaultFolder: string;
}

/** `?userId=` : quota d'un autre membre (droit « Demander pour un autre »), pour la feuille de demande. */
export const quotaQuerySchema = z.object({ userId: z.string().min(1).optional() });

export const sendOptionsParamsSchema = z.object({ type: mediaTypeSchema });
/** `?is4k=true&serverId=` : serveurs 4K, et profils/dossiers d'un serveur choisi plutôt que du serveur par défaut. */
export const sendOptionsQuerySchema = z.object({
  is4k: z.stringbool().default(false),
  serverId: z.coerce.number().int().positive().optional(),
});

export interface QuotaUsage {
  limit: number;
  days: number;
  used: number;
  remaining: number;
}

/** Quota restant du membre connecté (ou du membre `?userId=`) : films et saisons sur leur fenêtre glissante. */
export interface RequestQuota {
  movies: QuotaUsage;
  seasons: QuotaUsage;
  /** Propriétaire et gestionnaires : aucune limite, les champs ci-dessus sont indicatifs. */
  exempt: boolean;
}

export interface RequestCounts {
  /** Demandes en attente d'approbation ; `null` pour qui ne peut pas approuver. */
  pendingApprovals: number | null;
  /** Demandes en cours du membre connecté. */
  mineActive: number;
}

export type BatchItemResult =
  | { id: number; ok: true; request: RequestDetail }
  | { id: number; ok: false; error: string };
export interface BatchResult {
  results: BatchItemResult[];
}
