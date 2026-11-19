import { z } from 'zod';
import { apiErrorSchema } from '../../shared/api-error.ts';
import { API_VERSION_PATH, apiVersionSchema } from '../../shared/api-version.ts';
import {
  AUTH_SESSIONS_PATH,
  authSessionParamsSchema,
  authSessionPath,
  authSessionSchema,
  authSessionsSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  EMBY_TOKEN_PATH,
  embyTokenLoginSchema,
  embyTokenSessionSchema,
  LOGIN_PATH,
  LOGOUT_PATH,
  loginSchema,
  userPath,
  VIEWER_PATH,
  viewerResponseSchema,
  viewerSchema,
} from '../../shared/auth.ts';
import {
  browsePath,
  browseQuerySchema,
  collectionPath,
  DISCOVER_PATH,
  discoverListPath,
  discoverResponseSchema,
  genresPath,
  genresResponseSchema,
  idParamsSchema,
  imageParamsSchema,
  mediaPath,
  pagedMediaSchema,
  pageQuerySchema,
  personPath,
  providersPath,
  providersResponseSchema,
  SEARCH_PATH,
  searchQuerySchema,
  typeIdParamsSchema,
  typeParamsSchema,
} from '../../shared/catalogue.ts';
import { HEALTH_PATH, healthSchema } from '../../shared/health.ts';
import {
  collectionDetailsSchema,
  genreSchema,
  IMAGE_BASE_URL,
  mediaDetailsSchema,
  mediaKeySchema,
  mediaSearchResultsSchema,
  mediaSummarySchema,
  personDetailsSchema,
  watchProviderSchema,
} from '../../shared/media.ts';
import {
  markNotificationsReadSchema,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_PATH,
  notificationListQuerySchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationPreferencesViewSchema,
  notificationsReadSchema,
  notificationViewSchema,
} from '../../shared/notifications.ts';
import {
  createRequestSchema,
  quotaQuerySchema,
  quotaUsageSchema,
  REQUEST_COUNTS_PATH,
  REQUEST_QUOTA_PATH,
  REQUESTS_PATH,
  requestCountsSchema,
  requestDetailSchema,
  requestIdParamsSchema,
  requestListQuerySchema,
  requestPageSchema,
  requestPath,
  requestPersonSchema,
  requestQuotaSchema,
  requestViewSchema,
  updateRequestSchema,
} from '../../shared/requests.ts';
import { capabilitiesSchema } from '../../shared/roles.ts';
import {
  addedToWatchlistSchema,
  addWatchlistSchema,
  autoRequestSettingSchema,
  importPath,
  importQuerySchema,
  inWatchlistSchema,
  letterboxdImportSchema,
  traktImportSchema,
  WATCHLIST_AUTO_REQUEST_PATH,
  WATCHLIST_ITEM_ROUTE,
  WATCHLIST_PATH,
  watchlistEntrySchema,
  watchlistImportResultSchema,
  watchlistPageSchema,
} from '../../shared/watchlist.ts';
import { AVATAR_TYPES } from '../routes/users.ts';
import { CONTENT_TYPES } from '../services/images.ts';

/** Fiche media telle que la route la répond : `embyItemId` y est toujours présent (`null` hors du serveur). */
const mediaDetailsResponseSchema = mediaDetailsSchema.extend({ embyItemId: z.string().nullable() });

/**
 * Schémas nommés du document (`components.schemas`), référencés par `$ref` partout où ils apparaissent. Seuls ceux
 * qu'une opération utilise sont écrits.
 */
export const COMPONENTS: Record<string, z.ZodType> = {
  AddedToWatchlist: addedToWatchlistSchema,
  ApiError: apiErrorSchema,
  ApiVersion: apiVersionSchema,
  AuthSession: authSessionSchema,
  AutoRequestSetting: autoRequestSettingSchema,
  Capabilities: capabilitiesSchema,
  CollectionDetails: collectionDetailsSchema,
  DiscoverResponse: discoverResponseSchema,
  EmbyTokenSession: embyTokenSessionSchema,
  Genre: genreSchema,
  Health: healthSchema,
  InWatchlist: inWatchlistSchema,
  MediaDetails: mediaDetailsResponseSchema,
  MediaKey: mediaKeySchema,
  MediaSearchResults: mediaSearchResultsSchema,
  MediaSummary: mediaSummarySchema,
  NotificationPage: notificationPageSchema,
  NotificationPreferences: notificationPreferencesViewSchema,
  NotificationView: notificationViewSchema,
  PagedMedia: pagedMediaSchema,
  PersonDetails: personDetailsSchema,
  QuotaUsage: quotaUsageSchema,
  RequestCounts: requestCountsSchema,
  RequestDetail: requestDetailSchema,
  RequestPage: requestPageSchema,
  RequestPerson: requestPersonSchema,
  RequestQuota: requestQuotaSchema,
  RequestView: requestViewSchema,
  Viewer: viewerSchema,
  ViewerResponse: viewerResponseSchema,
  WatchlistEntry: watchlistEntrySchema,
  WatchlistImportResult: watchlistImportResultSchema,
  WatchlistPage: watchlistPageSchema,
  WatchProvider: watchProviderSchema,
};

export const TAGS = {
  system: 'Santé du serveur et version du contrat de l’API.',
  auth: 'Connexion, déconnexion, membre connecté et ses sessions.',
  catalogue: 'Catalogue TMDB : Découvrir, Films et Séries, recherche, fiches, avec le statut de chaque titre.',
  images: 'Images relayées par le serveur : TMDB (avec cache disque) et photos des membres.',
  requests: 'Demandes du membre connecté : création, suivi, modification, annulation, quota.',
  watchlist: 'Ma liste : la liste de souhaits du membre connecté, et ses imports.',
  notifications: 'Notifications du membre connecté et ses préférences.',
} as const;
export type Tag = keyof typeof TAGS;

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type ErrorCode = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 502 | 503;

/**
 * Corps d'une réponse réussie : schéma JSON, `null` sans contenu, l'un des deux avec sa description propre, ou une image
 * binaire de l'un des types `images`.
 */
export type SuccessBody =
  | z.ZodType
  | null
  | { description: string; schema: z.ZodType | null }
  | { description: string; images: Iterable<string> };

/** Membre de `GET /api/users/:id/avatar` : la route lit l'id tel quel, sans le valider. */
const userIdParamsSchema = z.object({ id: z.string() });

/**
 * Justificatifs acceptés : par défaut l'un des trois (cookie, Bearer, clé d'API) ; `session` : cookie ou Bearer, pas
 * de clé ; `optional` : aucun requis, cookie ou Bearer lus s'ils sont là ; `public` : aucun.
 */
export type Access = 'any' | 'session' | 'optional' | 'public';

export interface Operation {
  operationId: string;
  method: HttpMethod;
  /** Chemin Fastify (`:param`), tiré des constantes de `src/shared`. */
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  access?: Access;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Corps facultatif (le service lit `req.body ?? {}`). */
  bodyOptional?: true;
  responses: Partial<Record<200 | 201 | 204, SuccessBody>>;
  /** Erreurs propres à l'opération, en plus de celles déduites (400 d'entrée, 401, 403 d'écriture par cookie). */
  errors?: Partial<Record<ErrorCode, string>>;
}

/** Réponses d'erreur reprises par plusieurs opérations (`ErrorCode` → description). */
export const CSRF_ERROR = 'Écriture par cookie sans l’en-tête CSRF, ou d’une autre origine';
const LOGIN_RATE_LIMIT = 'Trop de tentatives de connexion depuis cette adresse (en-tête `Retry-After`)';
const API_KEY_REFUSED = 'Refusé avec une clé d’API';
const IMPORT_RUNNING = 'Un import est déjà en cours pour ce membre';
const IMPORT_RATE_LIMIT = 'Trop d’imports (en-tête `Retry-After`)';
const AUTO_REQUEST_FORBIDDEN = 'Sans le droit de demande automatique depuis Ma liste';
const CAN_REQUEST_FORBIDDEN = 'Sans le droit de faire des demandes';
const TMDB_ERRORS = { 502: 'TMDB injoignable ou réponse hors contrat', 503: 'TMDB pas encore configuré' } as const;

/** Opérations documentées, dans l'ordre du document. */
export const OPERATIONS: Operation[] = [
  // --- Système ---
  {
    operationId: 'getHealth',
    method: 'get',
    path: HEALTH_PATH,
    tag: 'system',
    summary: 'Santé du serveur et de sa base',
    access: 'public',
    responses: { 200: healthSchema },
    errors: { 503: 'Base de données indisponible' },
  },
  {
    operationId: 'getApiVersion',
    method: 'get',
    path: API_VERSION_PATH,
    tag: 'system',
    summary: 'Version du contrat de l’API et capacités du serveur',
    description: 'Un client natif y détecte un serveur trop ancien : `features` liste les capacités disponibles.',
    access: 'public',
    responses: { 200: apiVersionSchema },
  },

  // --- Authentification ---
  {
    operationId: 'login',
    method: 'post',
    path: LOGIN_PATH,
    tag: 'auth',
    summary: 'Connexion par identifiant et mot de passe Emby ou Jellyfin',
    description:
      'Navigateur : la session est posée en cookie signé (`Set-Cookie`), rien dans le corps. Exige l’en-tête ' +
      `\`${CSRF_HEADER}: ${CSRF_VALUE}\` et une origine absente ou identique à l’hôte.`,
    access: 'public',
    body: loginSchema,
    responses: { 200: viewerResponseSchema },
    errors: {
      400: 'Le serveur multimédia configuré se connecte autrement (Plex)',
      401: 'Identifiant ou mot de passe refusé',
      403: CSRF_ERROR,
      429: LOGIN_RATE_LIMIT,
      502: 'Serveur multimédia injoignable',
      503: 'Serveur multimédia pas encore configuré',
    },
  },
  {
    operationId: 'loginWithEmbyToken',
    method: 'post',
    path: EMBY_TOKEN_PATH,
    tag: 'auth',
    summary: 'Connexion d’un client natif par son jeton d’accès Emby ou Jellyfin',
    description:
      'Le serveur multimédia confirme que le jeton vaut pour `userId`. Le jeton de session renvoyé (montré une seule fois) ' +
      's’envoie ensuite en `Authorization: Bearer`. Aucun cookie, pas de contrôle CSRF.',
    access: 'public',
    body: embyTokenLoginSchema,
    responses: { 200: embyTokenSessionSchema },
    errors: {
      400: 'Le serveur multimédia configuré n’est ni Emby ni Jellyfin, ou aucun serveur configuré',
      401: 'Jeton refusé, ou valable pour un autre compte',
      429: LOGIN_RATE_LIMIT,
      502: 'Serveur multimédia injoignable',
    },
  },
  {
    operationId: 'logout',
    method: 'post',
    path: LOGOUT_PATH,
    tag: 'auth',
    summary: 'Déconnexion : révoque la session courante',
    description: 'En Bearer, révoque la session du jeton ; sinon celle du cookie, qui est effacé.',
    access: 'optional',
    responses: { 204: null },
    errors: { 403: CSRF_ERROR },
  },
  {
    operationId: 'getViewer',
    method: 'get',
    path: VIEWER_PATH,
    tag: 'auth',
    summary: 'Membre connecté et ses droits',
    description: 'Prolonge aussi le cookie de session (expiration glissante).',
    responses: { 200: viewerResponseSchema },
  },
  {
    operationId: 'listSessions',
    method: 'get',
    path: AUTH_SESSIONS_PATH,
    tag: 'auth',
    summary: 'Sessions en cours du membre connecté (navigateurs et appareils)',
    access: 'session',
    responses: { 200: authSessionsSchema },
    errors: { 403: API_KEY_REFUSED },
  },
  {
    operationId: 'revokeSession',
    method: 'delete',
    path: authSessionPath(':id'),
    tag: 'auth',
    summary: 'Révoque une session du membre connecté (la courante comprise)',
    access: 'session',
    params: authSessionParamsSchema,
    responses: { 204: null },
    errors: { 403: API_KEY_REFUSED, 404: 'Session inconnue, expirée ou d’un autre membre' },
  },

  // --- Catalogue ---
  {
    operationId: 'getDiscover',
    method: 'get',
    path: DISCOVER_PATH,
    tag: 'catalogue',
    summary: 'Rangées de Découvrir, dans l’ordre choisi par le propriétaire',
    responses: { 200: discoverResponseSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'listProviderTitles',
    method: 'get',
    path: discoverListPath(':type', ':id'),
    tag: 'catalogue',
    summary: 'Titres d’une plateforme de streaming, paginés',
    params: typeIdParamsSchema,
    query: pageQuerySchema,
    responses: { 200: pagedMediaSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'browse',
    method: 'get',
    path: browsePath(':type'),
    tag: 'catalogue',
    summary: 'Films ou séries filtrés et triés, paginés',
    description: '`genres` : identifiants séparés par des virgules (`28,12`), tous exigés à la fois.',
    params: typeParamsSchema,
    query: browseQuerySchema,
    responses: { 200: pagedMediaSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'listGenres',
    method: 'get',
    path: genresPath(':type'),
    tag: 'catalogue',
    summary: 'Genres TMDB des films ou des séries',
    params: typeParamsSchema,
    responses: { 200: genresResponseSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'listProviders',
    method: 'get',
    path: providersPath(':type'),
    tag: 'catalogue',
    summary: 'Plateformes de streaming (France, abonnement)',
    params: typeParamsSchema,
    responses: { 200: providersResponseSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'search',
    method: 'get',
    path: SEARCH_PATH,
    tag: 'catalogue',
    summary: 'Recherche de films, séries et personnes',
    query: searchQuerySchema,
    responses: { 200: mediaSearchResultsSchema },
    errors: TMDB_ERRORS,
  },
  {
    operationId: 'getPerson',
    method: 'get',
    path: personPath(':id'),
    tag: 'catalogue',
    summary: 'Fiche d’une personne et sa filmographie',
    params: idParamsSchema,
    responses: { 200: personDetailsSchema },
    errors: { 404: 'Personne introuvable', ...TMDB_ERRORS },
  },
  {
    operationId: 'getCollection',
    method: 'get',
    path: collectionPath(':id'),
    tag: 'catalogue',
    summary: 'Saga (collection TMDB) et ses films',
    params: idParamsSchema,
    responses: { 200: collectionDetailsSchema },
    errors: { 404: 'Saga introuvable', ...TMDB_ERRORS },
  },
  {
    operationId: 'getMedia',
    method: 'get',
    path: mediaPath(':type', ':id'),
    tag: 'catalogue',
    summary: 'Fiche d’un film ou d’une série, avec son statut et celui de chaque saison',
    description:
      '`id` : identifiant TMDB. `embyItemId` est toujours présent : l’id de l’élément sur le serveur multimédia, `null` ' +
      'si le titre n’y est pas.',
    params: typeIdParamsSchema,
    responses: { 200: mediaDetailsResponseSchema },
    errors: { 404: 'Titre introuvable', ...TMDB_ERRORS },
  },

  // --- Images ---
  {
    operationId: 'getImage',
    method: 'get',
    path: `${IMAGE_BASE_URL}/:size/:file`,
    tag: 'images',
    summary: 'Image TMDB (affiche, fond, portrait), mise en cache par le serveur',
    params: imageParamsSchema,
    responses: {
      200: { description: 'Image (en cache 30 jours, immuable)', images: Object.values(CONTENT_TYPES) },
    },
    errors: { 404: 'Image introuvable', 502: 'TMDB injoignable' },
  },
  {
    operationId: 'getUserAvatar',
    method: 'get',
    path: userPath(':id', 'avatar'),
    tag: 'images',
    summary: 'Photo d’un membre, relayée depuis le serveur multimédia',
    description: 'Adresse de `avatarUrl` (membre connecté, demandes, sélecteurs). `id` : id du membre.',
    params: userIdParamsSchema,
    responses: { 200: { description: 'Photo (en cache privé 24 heures)', images: AVATAR_TYPES } },
    errors: {
      404: 'Membre sans photo, ou photo introuvable sur le serveur multimédia',
      502: 'Serveur multimédia injoignable, ou type d’image inattendu',
      503: 'Serveur multimédia pas encore configuré',
    },
  },

  // --- Demandes ---
  {
    operationId: 'createRequest',
    method: 'post',
    path: REQUESTS_PATH,
    tag: 'requests',
    summary: 'Demande un film ou des saisons d’une série',
    description:
      'Approuvée et envoyée d’office si le membre a le droit d’approbation automatique. `forUserId`, `quotaExempt` et ' +
      'les choix d’envoi demandent des droits supplémentaires.',
    body: createRequestSchema,
    responses: {
      200: {
        description: 'La même demande était déjà en cours : elle est renvoyée, rien n’est créé',
        schema: requestDetailSchema,
      },
      201: { description: 'Demande créée', schema: requestDetailSchema },
    },
    errors: {
      403: 'Droit manquant (type, 4K, pour un autre membre, hors quota, choix d’envoi) ou titre bloqué',
      404: 'Titre ou membre introuvable',
      400: 'Saison inconnue, spéciale ou pas encore diffusée',
      409: 'Quota atteint, titre déjà disponible ou déjà demandé, aucun serveur Radarr ou Sonarr configuré',
      ...TMDB_ERRORS,
    },
  },
  {
    operationId: 'listRequests',
    method: 'get',
    path: REQUESTS_PATH,
    tag: 'requests',
    summary: 'Demandes, paginées, avec le total par statut',
    description:
      '`status` : statuts séparés par des virgules (`pending,failed`) ; `mine` : `true` ou `false`. Un membre sans droit ' +
      'de gérer les demandes ne voit que les siennes ; `tmdbId` exige `type`.',
    query: requestListQuerySchema,
    responses: { 200: requestPageSchema },
    errors: { 403: CAN_REQUEST_FORBIDDEN },
  },
  {
    operationId: 'getRequestQuota',
    method: 'get',
    path: REQUEST_QUOTA_PATH,
    tag: 'requests',
    summary: 'Quota restant du membre connecté (ou d’un autre membre avec `userId`)',
    query: quotaQuerySchema,
    responses: { 200: requestQuotaSchema },
    errors: {
      403: CAN_REQUEST_FORBIDDEN + ' ; `userId` sans le droit « Demander pour un autre »',
      404: 'Membre introuvable',
    },
  },
  {
    operationId: 'getRequestCounts',
    method: 'get',
    path: REQUEST_COUNTS_PATH,
    tag: 'requests',
    summary: 'Compteurs : demandes en cours du membre, demandes à approuver',
    responses: { 200: requestCountsSchema },
    errors: { 403: CAN_REQUEST_FORBIDDEN },
  },
  {
    operationId: 'getRequest',
    method: 'get',
    path: requestPath(':id'),
    tag: 'requests',
    summary: 'Une demande et sa frise',
    params: requestIdParamsSchema,
    responses: { 200: requestDetailSchema },
    errors: { 403: CAN_REQUEST_FORBIDDEN, 404: 'Demande introuvable, ou d’un autre membre' },
  },
  {
    operationId: 'updateRequest',
    method: 'patch',
    path: requestPath(':id'),
    tag: 'requests',
    summary: 'Modifie une demande en attente (saisons, choix d’envoi)',
    description: 'Par le membre qui l’a faite, ou par un gestionnaire.',
    params: requestIdParamsSchema,
    body: updateRequestSchema,
    bodyOptional: true,
    responses: { 200: requestDetailSchema },
    errors: {
      400: 'Saisons ou type de série pour un film',
      403: 'Demande d’un autre membre, ou choix d’envoi sans le droit',
      404: 'Demande introuvable',
      409: 'Demande plus en attente, ou saisons déjà demandées',
    },
  },
  {
    operationId: 'cancelRequest',
    method: 'post',
    path: requestPath(':id', 'cancel'),
    tag: 'requests',
    summary: 'Annule une demande du membre encore en attente',
    params: requestIdParamsSchema,
    responses: { 200: requestDetailSchema },
    errors: {
      403: 'Demande d’un autre membre',
      404: 'Demande introuvable, ou d’un autre membre',
      409: 'Demande plus en attente',
    },
  },

  // --- Ma liste ---
  {
    operationId: 'listWatchlist',
    method: 'get',
    path: WATCHLIST_PATH,
    tag: 'watchlist',
    summary: 'Ma liste, paginée, avec le statut de chaque titre',
    query: pageQuerySchema,
    responses: { 200: watchlistPageSchema },
  },
  {
    operationId: 'addToWatchlist',
    method: 'post',
    path: WATCHLIST_PATH,
    tag: 'watchlist',
    summary: 'Ajoute un titre à Ma liste (idempotent)',
    description:
      'Si l’option du membre est active, le titre est aussi demandé : `autoRequest` dit le sort de la demande.',
    body: addWatchlistSchema,
    responses: { 200: addedToWatchlistSchema },
    errors: { 404: 'Titre introuvable', ...TMDB_ERRORS },
  },
  {
    operationId: 'getWatchlistAutoRequest',
    method: 'get',
    path: WATCHLIST_AUTO_REQUEST_PATH,
    tag: 'watchlist',
    summary: 'Option « demander ce que j’ajoute à Ma liste »',
    responses: { 200: autoRequestSettingSchema },
    errors: { 403: AUTO_REQUEST_FORBIDDEN },
  },
  {
    operationId: 'setWatchlistAutoRequest',
    method: 'put',
    path: WATCHLIST_AUTO_REQUEST_PATH,
    tag: 'watchlist',
    summary: 'Active ou désactive la demande automatique depuis Ma liste',
    body: autoRequestSettingSchema,
    responses: { 200: autoRequestSettingSchema },
    errors: { 403: AUTO_REQUEST_FORBIDDEN },
  },
  {
    operationId: 'isInWatchlist',
    method: 'get',
    path: WATCHLIST_ITEM_ROUTE,
    tag: 'watchlist',
    summary: 'Le titre est-il dans Ma liste ?',
    params: typeIdParamsSchema,
    responses: { 200: inWatchlistSchema },
  },
  {
    operationId: 'removeFromWatchlist',
    method: 'delete',
    path: WATCHLIST_ITEM_ROUTE,
    tag: 'watchlist',
    summary: 'Retire un titre de Ma liste (idempotent)',
    params: typeIdParamsSchema,
    responses: { 200: inWatchlistSchema },
  },
  {
    operationId: 'importTraktWatchlist',
    method: 'post',
    path: importPath('trakt'),
    tag: 'watchlist',
    summary: 'Importe la liste de souhaits publique d’un compte Trakt',
    description: '`dryRun=true` : aperçu, rien n’est écrit.',
    query: importQuerySchema,
    body: traktImportSchema,
    responses: { 200: watchlistImportResultSchema },
    errors: {
      409: IMPORT_RUNNING,
      422: 'Profil Trakt privé ou introuvable',
      429: IMPORT_RATE_LIMIT,
      502: 'Trakt ou TMDB injoignable',
      503: 'Trakt ou TMDB pas encore configuré',
    },
  },
  {
    operationId: 'importLetterboxdWatchlist',
    method: 'post',
    path: importPath('letterboxd'),
    tag: 'watchlist',
    summary: 'Importe le `watchlist.csv` d’un export Letterboxd',
    description: '`dryRun=true` : aperçu, rien n’est écrit.',
    query: importQuerySchema,
    body: letterboxdImportSchema,
    responses: { 200: watchlistImportResultSchema },
    errors: {
      409: IMPORT_RUNNING,
      422: 'Fichier non reconnu, ou liste trop longue',
      429: IMPORT_RATE_LIMIT,
      ...TMDB_ERRORS,
    },
  },

  // --- Notifications ---
  {
    operationId: 'listNotifications',
    method: 'get',
    path: NOTIFICATIONS_PATH,
    tag: 'notifications',
    summary: 'Notifications du membre connecté, paginées, avec le nombre de non lues',
    query: notificationListQuerySchema,
    responses: { 200: notificationPageSchema },
  },
  {
    operationId: 'markNotificationsRead',
    method: 'post',
    path: NOTIFICATIONS_READ_PATH,
    tag: 'notifications',
    summary: 'Marque comme lues certaines notifications (`ids`) ou toutes (`all`)',
    body: markNotificationsReadSchema,
    responses: { 200: notificationsReadSchema },
  },
  {
    operationId: 'getNotificationPreferences',
    method: 'get',
    path: NOTIFICATION_PREFERENCES_PATH,
    tag: 'notifications',
    summary: 'Préférences de notification du compte',
    responses: { 200: notificationPreferencesViewSchema },
  },
  {
    operationId: 'setNotificationPreferences',
    method: 'put',
    path: NOTIFICATION_PREFERENCES_PATH,
    tag: 'notifications',
    summary: 'Enregistre les préférences de notification du compte',
    body: notificationPreferencesSchema,
    responses: { 200: notificationPreferencesViewSchema },
    errors: { 403: 'Type de notification que le membre ne peut pas recevoir' },
  },
];
