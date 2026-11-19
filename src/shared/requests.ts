import { z } from 'zod';
import type { ArrServerSummary } from './arr-servers.ts';
import { type MediaType, mediaSummarySchema, mediaTypeSchema, pagedSchema, type Season } from './media.ts';
import type { AppliedRule } from './override-rules.ts';
import type { Capabilities } from './roles.ts';
import { profileId, rootFolderPath, type SeriesType, seriesTypes } from './settings.ts';
import type { ArrTestResult } from './setup.ts';
import {
  isRequestableStatus,
  type MediaStatus,
  type RequestStatus,
  requestEventTypes,
  requestStatuses,
  requestStatusSchema,
} from './status.ts';

// --- Adresses de l'API ---

export const REQUESTS_PATH = '/api/requests';
export const REQUEST_QUOTA_PATH = `${REQUESTS_PATH}/quota`;
export const REQUEST_COUNTS_PATH = `${REQUESTS_PATH}/counts`;
export const REQUEST_BATCH_PATH = `${REQUESTS_PATH}/batch`;
export const sendOptionsPath = (type: MediaType | ':type') => `${REQUESTS_PATH}/send-options/${type}`;
/** Une demande, ou l'une de ses actions. */
export const requestPath = (id: number | ':id', action?: 'approve' | 'decline' | 'retry' | 'cancel') =>
  `${REQUESTS_PATH}/${id}${action ? `/${action}` : ''}`;

// --- Saisons demandables ---

/**
 * Jour courant (`AAAA-MM-JJ`, UTC) pour comparer aux dates de diffusion TMDB : même base côté serveur (règle) et
 * côté feuille de demande (affichage), pour qu'une saison proposée ne soit jamais refusée.
 */
export const isoDay = (at: number | Date = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Saison diffusée à `day` (`isoDay`) : au moins un épisode et une date de diffusion passée. */
export const isAiredSeason = (season: Pick<Season, 'episodeCount' | 'airDate'>, day: string) =>
  season.episodeCount > 0 && !!season.airDate && season.airDate <= day;

/** Statut d'un titre ou d'une saison dans la qualité demandée (normale, ou 4K : serveurs 4K seuls). */
export const statusIn = (item: { status?: MediaStatus; fourK?: { status?: MediaStatus } }, is4k: boolean) =>
  is4k ? item.fourK?.status : item.status;

/**
 * Saisons qu'un membre peut encore demander : régulières (pas les spéciaux), diffusées, ni disponibles, ni en
 * téléchargement, ni déjà demandées (le statut d'une saison fusionne bibliothèque et demandes), dans cette qualité.
 */
export const requestableSeasons = (seasons: readonly Season[], day: string, is4k = false) =>
  seasons.filter((s) => s.seasonNumber > 0 && isAiredSeason(s, day) && isRequestableStatus(statusIn(s, is4k)));

/** Saisons voulues que ne couvre encore aucune demande en cours (numéros de saison des demandes actives). */
export const uncoveredSeasons = (wanted: readonly number[], covered: ReadonlySet<number>) =>
  wanted.filter((n) => !covered.has(n));

/**
 * « Demander » se propose pour un titre : un film, ou un titre dont on ne connaît pas les saisons (affiche, bande), tant
 * que son statut le permet ; une série dont on connaît les saisons (fiche) aussi quand une saison reste demandable, même
 * si une autre est déjà demandée (le statut du titre dit alors « Demandé »). Un titre disponible ne se demande jamais.
 */
export function isRequestable(
  media: {
    type: MediaType;
    status?: MediaStatus;
    fourK?: { status?: MediaStatus };
    seasons?: readonly Season[];
  },
  day: string,
  is4k = false,
) {
  const status = statusIn(media, is4k);
  if (media.type === 'movie' || !media.seasons) return isRequestableStatus(status);
  return (
    status !== 'available' && (isRequestableStatus(status) || requestableSeasons(media.seasons, day, is4k).length > 0)
  );
}

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

/**
 * Choix d'envoi (demande avancée, approbation) : serveur du bon type et de la bonne qualité, profil de qualité et
 * dossier racine de ce serveur. Le type de série ne vaut que pour une série.
 */
const sendChoiceFields = {
  serverId: z.number().int().positive().optional(),
  qualityProfileId: profileId.optional(),
  rootFolderPath: rootFolderPath.optional(),
};
const seriesTypeField = { seriesType: z.enum(seriesTypes).optional() };

/** Saisons choisies d'une série. */
const seasonList = z.array(seasonNumber).min(1).max(100);

/**
 * Film, ou saisons d'une série (`'all'`, par défaut : toutes les saisons diffusées encore manquantes). Les choix d'envoi
 * (« Options avancées ») demandent le droit « Demande avancée ».
 */
export const createRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), tmdbId, ...requestOptions, ...sendChoiceFields }),
  z.strictObject({
    type: z.literal('tv'),
    tmdbId,
    seasons: z.union([z.literal('all'), seasonList]).default('all'),
    ...requestOptions,
    ...sendChoiceFields,
    ...seriesTypeField,
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
export const approveRequestSchema = z.object({ ...sendChoiceFields, ...seriesTypeField, quotaExempt });
export type ApproveRequestInput = z.input<typeof approveRequestSchema>;

/**
 * Modification d'une demande en attente : ses saisons (série ; au moins une, sinon on l'annule) et ses choix d'envoi.
 * Un choix d'envoi présent remplace tout celui enregistré (un champ absent revient à la valeur du serveur) ; aucun : il
 * reste tel quel.
 */
export const updateRequestSchema = z
  .strictObject({ seasons: seasonList.optional(), ...sendChoiceFields, ...seriesTypeField })
  .refine((input) => Object.values(input).some((v) => v !== undefined), 'Rien à modifier');
export type UpdateRequestInput = z.input<typeof updateRequestSchema>;

/** Choix d'envoi d'une entrée (création, modification, approbation). */
export type SendChoiceInput = Pick<
  ApproveRequestInput,
  'serverId' | 'qualityProfileId' | 'rootFolderPath' | 'seriesType'
>;
const SEND_CHOICE_KEYS = ['serverId', 'qualityProfileId', 'rootFolderPath', 'seriesType'] as const;

/** L'entrée porte-t-elle un choix d'envoi ? */
export const hasSendChoice = (input: SendChoiceInput) => SEND_CHOICE_KEYS.some((key) => input[key] !== undefined);

/**
 * Qui peut faire des choix d'envoi : le droit « Demande avancée » ; en modification d'une demande en attente, aussi le
 * droit de gérer les demandes.
 */
export const canChooseSend = (capabilities: Capabilities, editing = false) =>
  capabilities.canAdvancedRequest || (editing && capabilities.canManageRequests);

/**
 * Un niveau de choix d'envoi. `serverId` absent : le niveau vaut pour n'importe quel serveur ; présent : ses profil,
 * dossier et type de série ne valent que si c'est le serveur retenu (ceux d'un autre serveur n'y existent pas).
 */
export interface SendChoiceLayer {
  serverId?: number | null | undefined;
  qualityProfileId?: number | null | undefined;
  rootFolderPath?: string | null | undefined;
  seriesType?: SeriesType | null | undefined;
}

/** Choix d'envoi seul, à envoyer : sans les autres champs de l'entrée ni les valeurs absentes. */
export const sendChoiceOf = (layer: SendChoiceLayer): SendChoiceInput =>
  Object.fromEntries(SEND_CHOICE_KEYS.flatMap((key) => (layer[key] == null ? [] : [[key, layer[key]]])));

/** Début du détail de l'évènement `requested` d'une modification (frise : « Modifiée par X »). */
export const REQUEST_EDITED_DETAIL = 'Demande modifiée';

/** Choix enregistré sur une demande (serveur, profil, dossier, type de série). */
export const storedSendChoice = (request: {
  serverId: number | null;
  qualityProfileId: number | null;
  rootFolder: string | null;
  seriesType: SeriesType | null;
}): SendChoiceLayer => ({
  serverId: request.serverId,
  qualityProfileId: request.qualityProfileId,
  rootFolderPath: request.rootFolder,
  seriesType: request.seriesType,
});

/** Niveaux de choix d'envoi, nommés : leur ordre n'est écrit que dans `resolveSendChoice`. */
export interface SendChoiceLevels {
  /** Choix du gestionnaire à l'approbation (ou serveur déjà choisi pour lire les listes). */
  approver?: SendChoiceLayer | undefined;
  /** Choix enregistré sur la demande (demande avancée, import Seerr). */
  stored?: SendChoiceLayer | undefined;
  /** Règles de surcharge qui valent pour le titre (`ruleLayer`), dans leur ordre. */
  rules?: readonly SendChoiceLayer[] | undefined;
  /** Valeurs par défaut du serveur pour le titre (réglages anime compris). */
  defaults?: SendChoiceLayer | null | undefined;
}

/**
 * Ordre de priorité des choix d'envoi, le seul endroit où il est défini (voir DECISIONS.md) : 1. choix du gestionnaire
 * à l'approbation, 2. choix enregistré sur la demande, 3. règles de surcharge, la première l'emportant champ par champ,
 * 4. valeurs par défaut du serveur. Le serveur retenu est le premier donné (sinon `fallbackServerId`, le serveur par
 * défaut) ; chaque autre champ prend la première valeur d'un niveau qui vaut pour ce serveur.
 */
export function resolveSendChoice(
  { approver, stored, rules = [], defaults }: SendChoiceLevels,
  fallbackServerId?: number,
) {
  const layers = [approver, stored, ...rules, defaults].filter((layer) => layer != null);
  const serverId = layers.find((layer) => layer.serverId != null)?.serverId ?? fallbackServerId;
  const applies = layers.filter((layer) => layer.serverId == null || layer.serverId === serverId);
  const pick = <K extends keyof SendChoiceLayer>(key: K) =>
    applies.map((layer) => layer[key]).find((value) => value != null) ?? undefined;
  return {
    serverId: serverId ?? undefined,
    qualityProfileId: pick('qualityProfileId') as number | undefined,
    rootFolderPath: pick('rootFolderPath') as string | undefined,
    seriesType: pick('seriesType') as SeriesType | undefined,
  };
}

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
 * `?status=&type=&tmdbId=&mine=&userId=&page=` ; un membre sans droit d'approbation ne voit que ses demandes, quels que
 * soient `mine` et `userId` ; un gestionnaire lit celles d'un membre avec `userId` (`mine` l'emporte). `tmdbId` ne va pas sans `type` (un même id TMDB désigne un film et une série différents).
 */
export const requestListQuerySchema = z
  .object({
    status: statusList.optional(),
    type: mediaTypeSchema.optional(),
    tmdbId: z.coerce.number().pipe(tmdbId).optional(),
    mine: z.stringbool().default(false),
    userId: z.string().min(1).optional(),
    page: z.coerce.number().int().positive().default(1),
  })
  .refine((query) => query.tmdbId === undefined || query.type !== undefined, { path: ['type'] });
/** Filtres de la liste, côté client : `status` en tableau, sérialisé par `requestListParams`. */
export interface RequestListFilter {
  status?: readonly RequestStatus[];
  type?: MediaType;
  tmdbId?: number;
  mine?: boolean;
  /** Demandes d'un membre (gestionnaires seulement). */
  userId?: string;
  page?: number;
}

/** Seule écriture de la requête de la liste : `?status=a,b&type=&tmdbId=&mine=&userId=&page=`. */
export function requestListParams({ status, type, tmdbId, mine, userId, page }: RequestListFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (status?.length) params.set('status', status.join(','));
  if (type) params.set('type', type);
  if (tmdbId !== undefined) params.set('tmdbId', String(tmdbId));
  if (mine) params.set('mine', 'true');
  if (userId) params.set('userId', userId);
  if (page !== undefined) params.set('page', String(page));
  return params;
}

export const requestIdParamsSchema = z.object({ id: z.coerce.number().pipe(requestId) });

// --- Réponses ---

export const requestPersonSchema = z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() });
export type RequestPerson = z.output<typeof requestPersonSchema>;

export const requestViewSchema = z.object({
  id: z.number().int(),
  type: mediaTypeSchema,
  tmdbId: z.number().int(),
  status: requestStatusSchema,
  /** Saisons demandées (séries), triées ; vide pour un film. */
  seasons: z.array(z.number().int()),
  /** Membre à qui la demande appartient (quota, notifications). */
  requester: requestPersonSchema,
  /** Gestionnaire qui l'a faite à sa place (« Demandée par X pour Y ») ; `null` : le membre lui-même. */
  createdBy: requestPersonSchema.nullable(),
  /** Hors quota : ne compte pas dans le quota du membre. */
  quotaExempt: z.boolean(),
  /** Qui a approuvé ou refusé ; `null` tant que la demande est en attente. */
  decidedBy: requestPersonSchema.nullable(),
  declineReason: z.string().nullable(),
  qualityProfileId: z.number().int().nullable(),
  rootFolder: z.string().nullable(),
  seriesType: z.enum(seriesTypes).nullable(),
  is4k: z.boolean(),
  /** Serveur Radarr/Sonarr choisi (demande avancée, approbation) ; `null` = serveur par défaut au moment de l'envoi. */
  server: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Résumé TMDB (titre, affiche) ; `null` si TMDB ne répond pas. */
  media: mediaSummarySchema.nullable(),
  /** Raison du dernier échec d'envoi (frise) ; `null` sauf pour une demande en échec. */
  failureReason: z.string().nullable(),
});
export type RequestView = z.output<typeof requestViewSchema>;

export const requestEventViewSchema = z.object({
  id: z.number().int(),
  type: z.enum(requestEventTypes),
  actor: requestPersonSchema.nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
});
export type RequestEventView = z.output<typeof requestEventViewSchema>;

/** Demande avec sa frise, dans l'ordre chronologique. */
export const requestDetailSchema = requestViewSchema.extend({ events: z.array(requestEventViewSchema) });
export type RequestDetail = z.output<typeof requestDetailSchema>;

/**
 * Page de demandes, avec le nombre de demandes par statut sur tout le périmètre (les siennes, ou toutes pour un
 * approbateur, restreint au titre si `type`/`tmdbId`), quel que soit le filtre `status` : de quoi compter chaque onglet.
 */
export const requestPageSchema = pagedSchema(requestViewSchema).extend({
  totals: z.object(
    Object.fromEntries(requestStatuses.map((status) => [status, z.number().int()])) as Record<
      RequestStatus,
      z.ZodNumber
    >,
  ),
});
export type RequestPage = z.output<typeof requestPageSchema>;

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
  /** Profil, dossier et type de série par défaut : ceux de l'anime si `anime` ; type de série `null` pour Radarr. */
  defaultProfileId: number;
  defaultFolder: string;
  defaultSeriesType: SeriesType | null;
  /** Série d'animation d'un serveur qui route les animes : ses valeurs par défaut sont celles de l'anime. */
  anime: boolean;
  /**
   * Règles de surcharge qui jouent sur ce serveur pour le titre (`tmdbId`), dans l'ordre : déjà fondues dans le serveur
   * retenu (sans `serverId` demandé) et les valeurs par défaut ci-dessus.
   */
  rules: AppliedRule[];
}

/** `?userId=` : quota d'un autre membre (droit « Demander pour un autre »), pour la feuille de demande. */
export const quotaQuerySchema = z.object({ userId: z.string().min(1).optional() });

export const sendOptionsParamsSchema = z.object({ type: mediaTypeSchema });
/**
 * `?is4k=true&serverId=&tmdbId=` : serveurs 4K, profils/dossiers d'un serveur choisi plutôt que du serveur par défaut, et
 * valeurs par défaut du titre (une série d'animation prend les réglages anime du serveur).
 */
export const sendOptionsQuerySchema = z.object({
  is4k: z.stringbool().default(false),
  serverId: z.coerce.number().int().positive().optional(),
  tmdbId: z.coerce.number().int().positive().optional(),
});

export const quotaUsageSchema = z.object({
  limit: z.number().int(),
  days: z.number().int(),
  used: z.number().int(),
  remaining: z.number().int(),
});
export type QuotaUsage = z.output<typeof quotaUsageSchema>;

/** Quota restant du membre connecté (ou du membre `?userId=`) : films et saisons sur leur fenêtre glissante. */
export const requestQuotaSchema = z.object({
  movies: quotaUsageSchema,
  seasons: quotaUsageSchema,
  /** Propriétaire et gestionnaires : aucune limite, les champs ci-dessus sont indicatifs. */
  exempt: z.boolean(),
});
export type RequestQuota = z.output<typeof requestQuotaSchema>;

export const requestCountsSchema = z.object({
  /** Demandes en attente d'approbation ; `null` pour qui ne peut pas approuver. */
  pendingApprovals: z.number().int().nullable(),
  /** Demandes en cours du membre connecté. */
  mineActive: z.number().int(),
});
export type RequestCounts = z.output<typeof requestCountsSchema>;

export type BatchItemResult =
  | { id: number; ok: true; request: RequestDetail }
  | { id: number; ok: false; error: string };
export interface BatchResult {
  results: BatchItemResult[];
}
