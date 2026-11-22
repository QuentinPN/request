import { type AnyColumn, sql } from 'drizzle-orm';
import { check, customType, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { z } from 'zod';
import { apiKeyScopes } from '../../shared/api-keys.ts';
import { arrKinds } from '../../shared/arr-servers.ts';
import type { BlockedKeyword } from '../../shared/blocklist.ts';
import { issueStatuses, issueTypes } from '../../shared/issues.ts';
import { jobRunStatuses } from '../../shared/jobs.ts';
import { mediaTypes } from '../../shared/media.ts';
import { type NotificationChoices, notificationChoicesSchema, notificationKinds } from '../../shared/notifications.ts';
import {
  type PermissionOverrides,
  permissionOverridesSchema,
  type QuotaOverride,
  quotaOverrideSchema,
  roles,
} from '../../shared/roles.ts';
import { minimumAvailabilities, seriesTypes } from '../../shared/settings.ts';
import { mediaStatuses, preSendRequestStatuses, requestEventTypes, requestStatuses } from '../../shared/status.ts';
import { watchlistSources } from '../../shared/watchlist.ts';
import { enumCheck, inLiterals } from './checks.ts';

/**
 * Colonne JSON validée à la lecture par `schema` : une valeur illisible ou hors schéma (base éditée à la main,
 * ancien format) vaut `null` (valeur par défaut) et est journalisée, au lieu de faire échouer la connexion
 * ou la liste des membres.
 */
const tolerantJson = <T>(schema: z.ZodType<T>, unreadable: string) =>
  customType<{ data: T | null; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (stored) => {
      try {
        const parsed = schema.safeParse(JSON.parse(stored));
        if (parsed.success) return parsed.data;
      } catch {
        // JSON invalide : traité comme un format inconnu, ci-dessous.
      }
      console.error(unreadable);
      return null;
    },
  });

const quotaOverrideJson = tolerantJson<QuotaOverride>(
  quotaOverrideSchema,
  'quota_override illisible en base : quotas par défaut appliqués',
);
const permissionsJson = tolerantJson<PermissionOverrides>(
  permissionOverridesSchema,
  'permissions illisibles en base : droits du rôle appliqués',
);

const notificationTypesJson = tolerantJson<NotificationChoices>(
  notificationChoicesSchema,
  'notification_types illisibles en base : types par défaut appliqués',
);

/** Réglages clé/valeur : `value` est du JSON validé par Zod, les champs secrets y sont chiffrés. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Membres, identifiés par leur id sur le serveur multimédia (Emby, Jellyfin ou Plex : un seul à la fois, la colonne
 * garde son nom). `quotaOverride` : JSON `QuotaOverride`, `null` = quotas par défaut.
 * `lastLoginAt` : `null` tant que le membre (importé du serveur multimédia) ne s'est jamais connecté.
 * Notifications : `email` saisi par le membre (`null` = aucun courriel), canaux activés par `emailNotifications` et
 * `pushNotifications` (sans effet sans adresse ni appareil abonné).
 */
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    avatar: text(),
    role: text({ enum: roles }).notNull().default('member'),
    quotaOverride: quotaOverrideJson(),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    lastLoginAt: integer({ mode: 'timestamp' }),
    email: text(),
    emailNotifications: integer({ mode: 'boolean' }).notNull().default(true),
    pushNotifications: integer({ mode: 'boolean' }).notNull().default(true),
    permissions: permissionsJson(),
    /** JSON `NotificationChoices` : types de notification reçus, écart aux valeurs par défaut (`null` = défauts). */
    notificationTypes: notificationTypesJson(),
    /** Option du membre pour la demande automatique depuis Ma liste (lot suivant) : pas encore exposée. */
    watchlistAutoRequest: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    enumCheck('users_role_check', table.role, roles),
    check('users_quota_override_json_check', sql`${table.quotaOverride} IS NULL OR json_valid(${table.quotaOverride})`),
    check(
      'users_permissions_json_check',
      sql`${table.permissions} IS NULL OR (json_valid(${table.permissions}) AND json_type(${table.permissions}) = 'object')`,
    ),
    check(
      'users_notification_types_json_check',
      sql`${table.notificationTypes} IS NULL OR (json_valid(${table.notificationTypes}) AND json_type(${table.notificationTypes}) = 'object')`,
    ),
  ],
);

/** Sessions : `id` est le hash SHA-256 du jeton du cookie, jamais le jeton lui-même. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    lastSeenAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    userAgent: text(),
    /** Nom de l'appareil d'un client natif (`POST /api/auth/emby-token`) ; `NULL` pour une session de navigateur. */
    deviceName: text(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);

/**
 * Titres connus de l'appli (vus sur une affiche, dans Emby, Radarr ou Sonarr). Pas de titre ni d'affiche : TMDB reste
 * la source. `status` est un **cache** du statut de bibliothèque calculé par `services/availability.ts`
 * (`NULL` = absent : ni dans Emby ni chez Radarr/Sonarr), daté par `statusUpdatedAt` pour sa durée de vie.
 * `status4k` : même cache, calculé depuis les seuls serveurs 4K (`radarr4kId`/`sonarr4kId` : ids sur ces serveurs).
 * `embyItemId` : id de l'élément sur le serveur multimédia, quel qu'il soit (Emby, Jellyfin, Plex) ; nom conservé.
 */
export const media = sqliteTable(
  'media',
  {
    id: integer().primaryKey(),
    type: text({ enum: mediaTypes }).notNull(),
    tmdbId: integer().notNull(),
    tvdbId: integer(),
    radarrId: integer(),
    sonarrId: integer(),
    radarr4kId: integer('radarr_4k_id'),
    sonarr4kId: integer('sonarr_4k_id'),
    embyItemId: text(),
    status: text({ enum: mediaStatuses }),
    status4k: text('status_4k', { enum: mediaStatuses }),
    statusUpdatedAt: integer({ mode: 'timestamp' }).notNull(),
    /** Dernier calcul des saisons (série) ; `NULL` = jamais calculées, la fiche les calcule alors à la prochaine visite. */
    seasonsComputedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('media_type_check', table.type, mediaTypes),
    enumCheck('media_status_check', table.status, mediaStatuses),
    enumCheck('media_status_4k_check', table.status4k, mediaStatuses),
    // Badge de chaque affiche : lecture par lot `WHERE (type, tmdb_id) IN (VALUES …)`.
    uniqueIndex('media_type_tmdb_id_unique').on(table.type, table.tmdbId),
    // Webhooks Radarr/Sonarr (tâche 5.1). Partiels : la plupart des titres n'ont aucun de ces ids.
    index('media_tvdb_id_idx')
      .on(table.tvdbId)
      .where(sql`${table.tvdbId} IS NOT NULL`),
    index('media_radarr_id_idx')
      .on(table.radarrId)
      .where(sql`${table.radarrId} IS NOT NULL`),
    index('media_sonarr_id_idx')
      .on(table.sonarrId)
      .where(sql`${table.sonarrId} IS NOT NULL`),
    index('media_radarr_4k_id_idx')
      .on(table.radarr4kId)
      .where(sql`${table.radarr4kId} IS NOT NULL`),
    index('media_sonarr_4k_id_idx')
      .on(table.sonarr4kId)
      .where(sql`${table.sonarr4kId} IS NOT NULL`),
  ],
);

/** Statut par saison d'une série (cache, comme `media.status`) : seules les saisons ayant un statut ont une ligne. */
export const seasons = sqliteTable(
  'seasons',
  {
    id: integer().primaryKey(),
    mediaId: integer()
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    seasonNumber: integer().notNull(),
    status: text({ enum: mediaStatuses }).notNull(),
    /** Épisodes présents et attendus (diffusés) au dernier calcul ; `NULL` = inconnus (saison marquée « en téléchargement » par un webhook). */
    episodesPresent: integer(),
    episodesExpected: integer(),
  },
  (table) => [
    enumCheck('seasons_status_check', table.status, mediaStatuses),
    // Couvre aussi l'accès (et la cascade) par média.
    uniqueIndex('seasons_media_id_season_number_unique').on(table.mediaId, table.seasonNumber),
  ],
);

/**
 * Statut 4K par saison, même forme que `seasons` mais calculé depuis les seuls serveurs 4K. Table à part plutôt
 * qu'une colonne de `seasons` : une saison peut n'exister qu'en 4K (`seasons.status` est `NOT NULL`), et le calcul
 * normal remplace toutes les saisons d'un titre sans toucher à celles-ci.
 */
export const seasons4k = sqliteTable(
  'seasons_4k',
  {
    id: integer().primaryKey(),
    mediaId: integer()
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    seasonNumber: integer().notNull(),
    status: text({ enum: mediaStatuses }).notNull(),
    episodesPresent: integer(),
    episodesExpected: integer(),
  },
  (table) => [
    enumCheck('seasons_4k_status_check', table.status, mediaStatuses),
    uniqueIndex('seasons_4k_media_id_season_number_unique').on(table.mediaId, table.seasonNumber),
  ],
);

/**
 * Exécutions des tâches de fond. Verrou : une seule ligne `running` par tâche (index unique partiel) ; démarrer
 * = insérer, une violation d'unicité signifie « déjà en cours ».
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer().primaryKey(),
    job: text().notNull(),
    status: text({ enum: jobRunStatuses }).notNull(),
    startedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer({ mode: 'timestamp' }),
    detail: text(),
  },
  (table) => [
    enumCheck('job_runs_status_check', table.status, jobRunStatuses),
    // Littéral (pas de paramètre lié dans le DDL d'un index partiel).
    uniqueIndex('job_runs_running')
      .on(table.job)
      .where(sql`${table.status} = 'running'`),
    // « Dernier balayage » d'une tâche (`ORDER BY started_at DESC` parcourt l'index à rebours).
    index('job_runs_job_started_at_idx').on(table.job, table.startedAt),
  ],
);

/**
 * Serveurs Radarr et Sonarr (plusieurs par type, 4K ou non). `apiKey` : chiffrée comme les secrets des réglages
 * (`crypto.ts`). Au plus un serveur par défaut par couple (type, 4K). Profil, dossier, disponibilité minimale
 * (Radarr), type de série et profil de langue (Sonarr) : valeurs par défaut de l'approbation. `tags` : JSON, ids
 * d'étiquettes. Lot 8.3 : étiquette du membre, recherche à l'ajout, adresse externe et réglages anime (Sonarr).
 */
export const arrServers = sqliteTable(
  'arr_servers',
  {
    id: integer().primaryKey(),
    type: text({ enum: arrKinds }).notNull(),
    name: text().notNull(),
    url: text().notNull(),
    apiKey: text().notNull(),
    is4k: integer('is_4k', { mode: 'boolean' }).notNull().default(false),
    isDefault: integer({ mode: 'boolean' }).notNull().default(false),
    qualityProfileId: integer().notNull(),
    rootFolderPath: text().notNull(),
    minimumAvailability: text({ enum: minimumAvailabilities }),
    seriesType: text({ enum: seriesTypes }),
    languageProfileId: integer(),
    tags: text({ mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    tagRequester: integer({ mode: 'boolean' }).notNull().default(false),
    searchOnAdd: integer({ mode: 'boolean' }).notNull().default(true),
    externalUrl: text(),
    animeQualityProfileId: integer(),
    animeRootFolderPath: text(),
    animeSeriesType: text({ enum: seriesTypes }),
    animeLanguageProfileId: integer(),
    animeTags: text({ mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('arr_servers_type_check', table.type, arrKinds),
    enumCheck('arr_servers_minimum_availability_check', table.minimumAvailability, minimumAvailabilities),
    enumCheck('arr_servers_series_type_check', table.seriesType, seriesTypes),
    enumCheck('arr_servers_anime_series_type_check', table.animeSeriesType, seriesTypes),
    check('arr_servers_tags_json_check', sql`json_valid(${table.tags}) AND json_type(${table.tags}) = 'array'`),
    check(
      'arr_servers_anime_tags_json_check',
      sql`json_valid(${table.animeTags}) AND json_type(${table.animeTags}) = 'array'`,
    ),
    // Serveur par défaut de chaque couple (type, 4K) : en changer = retirer l'ancien et poser le nouveau, même transaction.
    uniqueIndex('arr_servers_default_unique')
      .on(table.type, table.is4k)
      .where(sql`${table.isDefault} = 1`),
  ],
);

/**
 * Demandes d'un membre (film, ou saisons d'une série dans `requestSeasons`). Profil, dossier et type de série sont
 * ceux choisis à l'approbation (`NULL` = valeur des réglages), repris tels quels par une relance.
 * `serverId` : serveur Radarr/Sonarr cible (`NULL` = serveur par défaut du type et de la qualité à l'envoi).
 * `createdBy` : auteur d'une demande faite à la place du membre (`NULL` = le membre lui-même).
 * `quotaExempt` : exemptée au cas par cas, ne compte pas dans le quota du membre.
 */
export const requests = sqliteTable(
  'requests',
  {
    id: integer().primaryKey(),
    mediaId: integer()
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: requestStatuses }).notNull(),
    decidedBy: text().references(() => users.id, { onDelete: 'set null' }),
    declineReason: text(),
    qualityProfileId: integer(),
    rootFolder: text(),
    seriesType: text({ enum: seriesTypes }),
    /** Demande 4K : envoyée à un serveur 4K, coexiste avec une demande normale du même titre (`requests_active`). */
    is4k: integer('is_4k', { mode: 'boolean' }).notNull().default(false),
    /** Origine d'une demande importée (`seerr:<id>`) : un nouvel import la reconnaît ; `NULL` = créée dans l'appli. */
    externalRef: text(),
    serverId: integer().references(() => arrServers.id, { onDelete: 'set null' }),
    quotaExempt: integer({ mode: 'boolean' }).notNull().default(false),
    createdBy: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('requests_status_check', table.status, requestStatuses),
    enumCheck('requests_series_type_check', table.seriesType, seriesTypes),
    // Double clic : une seule demande avant envoi par membre, par titre et par qualité (`onConflictDoNothing` sur cet index).
    uniqueIndex('requests_active')
      .on(table.mediaId, table.userId, table.is4k)
      .where(inLiterals(table.status, preSendRequestStatuses)),
    // « Mes demandes » et quota (fenêtre glissante sur `created_at`).
    index('requests_user_id_created_at_idx').on(table.userId, table.createdAt),
    // File d'approbation et compteur des demandes en attente.
    index('requests_status_created_at_idx').on(table.status, table.createdAt),
    // Statut affiché d'un titre (demandes par média) ; sert aussi la clé étrangère.
    index('requests_media_id_status_idx').on(table.mediaId, table.status),
    index('requests_decided_by_idx')
      .on(table.decidedBy)
      .where(sql`${table.decidedBy} IS NOT NULL`),
    // Import idempotent (6.2) : une demande importée ne l'est qu'une fois (SQLite tient les `NULL` pour distincts).
    uniqueIndex('requests_external_ref_unique').on(table.externalRef),
    // Statistiques : demandes par mois sur les 12 derniers (plage sur `created_at`, index couvrant).
    index('requests_created_at_idx').on(table.createdAt),
    // Clés étrangères (`SET NULL` à la suppression d'un serveur ou d'un membre) ; partiels, la plupart sont `NULL`.
    index('requests_server_id_idx')
      .on(table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    index('requests_created_by_idx')
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
  ],
);

/** Saisons demandées (séries) : le quota les compte, Sonarr les reçoit, la frise les affiche. */
export const requestSeasons = sqliteTable(
  'request_seasons',
  {
    requestId: integer()
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    seasonNumber: integer().notNull(),
    /** Date d'ajout de la saison à la demande : le quota (fenêtre glissante) compte chaque saison à sa date. */
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.seasonNumber] })],
);

/** Frise d'une demande : ajout seulement, jamais modifiée (une relance ajoute ses évènements). */
export const requestEvents = sqliteTable(
  'request_events',
  {
    id: integer().primaryKey(),
    requestId: integer()
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    type: text({ enum: requestEventTypes }).notNull(),
    actorId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Message lisible (échec d'envoi, motif de refus, id Radarr/Sonarr). */
    detail: text(),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('request_events_type_check', table.type, requestEventTypes),
    index('request_events_request_id_created_at_idx').on(table.requestId, table.createdAt),
    index('request_events_actor_id_idx')
      .on(table.actorId)
      .where(sql`${table.actorId} IS NOT NULL`),
  ],
);

/**
 * Notifications dans l'appli, une ligne par destinataire. Le texte est rendu à la lecture depuis `kind` (titre TMDB,
 * nom du demandeur) ; `detail` garde la donnée brute de l'évènement (motif du refus, raison de l'échec).
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: notificationKinds }).notNull(),
    requestId: integer().references(() => requests.id, { onDelete: 'set null' }),
    /** Signalement concerné (notifications `issue_*`). */
    issueId: integer().references(() => issues.id, { onDelete: 'set null' }),
    detail: text(),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    /** `NULL` = non lue. */
    readAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    enumCheck('notifications_kind_check', table.kind, notificationKinds),
    // Liste du membre, de la plus récente à la plus ancienne (le rowid termine l'index : `id DESC` départage).
    index('notifications_user_id_created_at_idx').on(table.userId, table.createdAt),
    // Pastille des non lues : compte sur l'index partiel, sans lire les notifications déjà lues.
    index('notifications_unread_idx')
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
    // Clé étrangère (`SET NULL` à la suppression d'une demande).
    index('notifications_request_id_idx')
      .on(table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
    index('notifications_issue_id_idx')
      .on(table.issueId)
      .where(sql`${table.issueId} IS NOT NULL`),
  ],
);

/**
 * Problèmes signalés sur un titre (saison et épisode facultatifs). `resolvedAt` est renseigné si et seulement si le
 * signalement est résolu (rouvrir l'efface, avec `resolvedBy`).
 */
export const issues = sqliteTable(
  'issues',
  {
    id: integer().primaryKey(),
    mediaId: integer()
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text({ enum: issueTypes }).notNull(),
    seasonNumber: integer(),
    episodeNumber: integer(),
    message: text().notNull(),
    status: text({ enum: issueStatuses }).notNull().default('open'),
    resolvedBy: text().references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('issues_type_check', table.type, issueTypes),
    enumCheck('issues_status_check', table.status, issueStatuses),
    check('issues_episode_check', sql`${table.episodeNumber} IS NULL OR ${table.seasonNumber} IS NOT NULL`),
    check('issues_resolved_check', sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL)`),
    // Liste des gestionnaires par statut (ouverts d'abord) et compteur des ouverts (statistiques).
    index('issues_status_created_at_idx').on(table.status, table.createdAt),
    // « Mes signalements » ; sert aussi la clé étrangère.
    index('issues_user_id_created_at_idx').on(table.userId, table.createdAt),
    // Signalements d'un titre (fiche) ; sert la clé étrangère et la purge des titres oubliés.
    index('issues_media_id_status_idx').on(table.mediaId, table.status),
    index('issues_resolved_by_idx')
      .on(table.resolvedBy)
      .where(sql`${table.resolvedBy} IS NOT NULL`),
  ],
);

/** Fil de commentaires d'un signalement ; `userId` `NULL` si l'auteur n'existe plus. */
export const issueComments = sqliteTable(
  'issue_comments',
  {
    id: integer().primaryKey(),
    issueId: integer()
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: text().references(() => users.id, { onDelete: 'set null' }),
    message: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('issue_comments_issue_id_created_at_idx').on(table.issueId, table.createdAt),
    index('issue_comments_user_id_idx')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
  ],
);

/**
 * Liste de souhaits d'un membre. Pas de lien vers `media` : un titre souhaité n'a ni statut ni demande, TMDB reste la
 * source ; titre, année et affiche sont une copie pour l'affichage (import Trakt/Letterboxd).
 */
export const watchlist = sqliteTable(
  'watchlist',
  {
    id: integer().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mediaType: text({ enum: mediaTypes }).notNull(),
    tmdbId: integer().notNull(),
    title: text(),
    year: integer(),
    posterPath: text(),
    source: text({ enum: watchlistSources }).notNull().default('manual'),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('watchlist_media_type_check', table.mediaType, mediaTypes),
    enumCheck('watchlist_source_check', table.source, watchlistSources),
    // Import idempotent (`onConflictDoNothing`) ; sert aussi la liste du membre et le bouton de la fiche.
    uniqueIndex('watchlist_user_id_media_type_tmdb_id_unique').on(table.userId, table.mediaType, table.tmdbId),
  ],
);

/** Abonnements push, un par appareil (`endpoint` unique). Pas des secrets du serveur : stockés en clair. */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Réabonnement d'un appareil (`onConflictDoUpdate`) et suppression sur réponse 404/410 du service push.
    uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpoint),
    index('push_subscriptions_user_id_idx').on(table.userId),
  ],
);

/** Titres bloqués : non demandables, retirés de Découvrir et de la recherche des membres. */
export const blockedTitles = sqliteTable(
  'blocked_titles',
  {
    id: integer().primaryKey(),
    mediaType: text({ enum: mediaTypes }).notNull(),
    tmdbId: integer().notNull(),
    title: text().notNull(),
    blockedBy: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('blocked_titles_media_type_check', table.mediaType, mediaTypes),
    // Refus d'une demande et filtrage par lot `WHERE (media_type, tmdb_id) IN (VALUES …)`.
    uniqueIndex('blocked_titles_media_type_tmdb_id_unique').on(table.mediaType, table.tmdbId),
    index('blocked_titles_blocked_by_idx')
      .on(table.blockedBy)
      .where(sql`${table.blockedBy} IS NOT NULL`),
  ],
);

/**
 * Clés d'API publiques : seul le hash SHA-256 (hexadécimal) est gardé, `prefix` sert à les reconnaître. Une clé
 * authentifie comme son créateur, limitée à sa portée (`scope`, `full` pour les clés d'avant les portées) ; révoquée
 * (`revokedAt`), elle ne sert plus.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    keyHash: text().notNull(),
    prefix: text().notNull(),
    scope: text({ enum: apiKeyScopes }).notNull().default('full'),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    lastUsedAt: integer({ mode: 'timestamp' }),
    revokedAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    enumCheck('api_keys_scope_check', table.scope, apiKeyScopes),
    // Authentification d'une requête `X-Api-Key` : recherche par hash.
    uniqueIndex('api_keys_key_hash_unique').on(table.keyHash),
    index('api_keys_created_by_idx').on(table.createdBy),
  ],
);

/** `CHECK (json_valid(colonne) AND json_type(colonne) = 'array')` : liste JSON (conditions et étiquettes des règles). */
const jsonArrayCheck = (name: string, column: AnyColumn) =>
  check(name, sql`json_valid(${column}) AND json_type(${column}) = 'array'`);

/**
 * Règles de surcharge (lot 8.8, Seerr `OverrideRule`). Conditions en listes JSON (genres et mots-clés TMDB, langues
 * originales) : toujours lues en entier avec la règle, jamais filtrées en SQL. Effets `NULL` = inchangés ; `tags` : ids
 * d'étiquettes ajoutées. `position` : la première règle qui correspond l'emporte (sans `UNIQUE`, le réordonnancement
 * réécrit toutes les positions). Supprimer le serveur supprime ses règles.
 */
export const overrideRules = sqliteTable(
  'override_rules',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    type: text({ enum: mediaTypes }).notNull(),
    serverId: integer()
      .notNull()
      .references(() => arrServers.id, { onDelete: 'cascade' }),
    genres: text({ mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    languages: text({ mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    keywords: text({ mode: 'json' })
      .$type<BlockedKeyword[]>()
      .notNull()
      .default(sql`'[]'`),
    qualityProfileId: integer(),
    rootFolderPath: text(),
    seriesType: text({ enum: seriesTypes }),
    tags: text({ mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    position: integer().notNull(),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    createdAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('override_rules_type_check', table.type, mediaTypes),
    enumCheck('override_rules_series_type_check', table.seriesType, seriesTypes),
    check('override_rules_movie_series_type_check', sql`${table.type} = 'tv' OR ${table.seriesType} IS NULL`),
    jsonArrayCheck('override_rules_genres_json_check', table.genres),
    jsonArrayCheck('override_rules_languages_json_check', table.languages),
    jsonArrayCheck('override_rules_keywords_json_check', table.keywords),
    jsonArrayCheck('override_rules_tags_json_check', table.tags),
    // Suppression d'un serveur : la cascade cherche ses règles par cet index.
    index('override_rules_server_id_idx').on(table.serverId),
  ],
);
