import { z } from 'zod';
import type { MediaSummary, MediaType, Paged } from './media.ts';
import { profileId, rootFolderPath, type Setting, seriesTypes } from './settings.ts';
import { type RequestEventType, type RequestStatus, requestStatusSchema } from './status.ts';

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
/** `?status=&mine=&page=` ; un membre sans droit d'approbation ne voit que ses demandes, quel que soit `mine`. */
export const requestListQuerySchema = z.object({
  status: requestStatusSchema.optional(),
  mine: z.stringbool().default(false),
  page: z.coerce.number().int().positive().default(1),
});
export type RequestListQuery = z.input<typeof requestListQuerySchema>;

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

export type RequestPage = Paged<RequestView>;

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
