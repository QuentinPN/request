import { z } from 'zod';
import { type MediaSummary, type MediaType, mediaTypeSchema, type Paged, type Season } from './media.ts';
import { profileId, rootFolderPath, type Setting, seriesTypes } from './settings.ts';
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

/** Film, ou saisons d'une série (`'all'`, par défaut : toutes les saisons diffusées encore manquantes). */
export const createRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), tmdbId }),
  z.strictObject({
    type: z.literal('tv'),
    tmdbId,
    seasons: z.union([z.literal('all'), z.array(seasonNumber).min(1).max(100)]).default('all'),
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
export type DeclineRequestInput = z.input<typeof declineRequestSchema>;

/** Choix de l'approbateur avant envoi ; chaque champ absent prend la valeur des réglages Radarr/Sonarr. */
export const approveRequestSchema = z.object({
  qualityProfileId: profileId.optional(),
  rootFolderPath: rootFolderPath.optional(),
  seriesType: z.enum(seriesTypes).optional(),
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
  requester: RequestPerson;
  /** Qui a approuvé ou refusé ; `null` tant que la demande est en attente. */
  decidedBy: RequestPerson | null;
  declineReason: string | null;
  qualityProfileId: number | null;
  rootFolder: string | null;
  seriesType: Setting<'sonarr'>['seriesType'] | null;
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
 * Profils de qualité et dossiers racines de Radarr ou Sonarr, avec les valeurs par défaut des réglages : ce qu'un
 * approbateur peut choisir avant l'envoi (ni adresse, ni clé).
 */
export interface SendOptions {
  qualityProfiles: ArrTestResult['qualityProfiles'];
  rootFolders: ArrTestResult['rootFolders'];
  defaultProfileId: number;
  defaultFolder: string;
}

export const sendOptionsParamsSchema = z.object({ type: mediaTypeSchema });

export interface QuotaUsage {
  limit: number;
  days: number;
  used: number;
  remaining: number;
}

/** Quota restant du membre connecté : films et saisons sur leur fenêtre glissante. */
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
