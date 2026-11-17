import { sql } from 'drizzle-orm';
import { check, customType, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { jobRunStatuses } from '../../shared/jobs.ts';
import { mediaTypes } from '../../shared/media.ts';
import { type QuotaOverride, quotaOverrideSchema, roles } from '../../shared/roles.ts';
import { seriesTypes } from '../../shared/settings.ts';
import { mediaStatuses, preSendRequestStatuses, requestEventTypes, requestStatuses } from '../../shared/status.ts';
import { enumCheck, inLiterals } from './checks.ts';

/**
 * JSON validé à la lecture par `quotaOverrideSchema` : une valeur illisible ou hors schéma (base éditée à la main,
 * ancien format) vaut `null` (quotas par défaut) et est journalisée, au lieu de faire échouer la connexion
 * ou la liste des membres.
 */
const quotaOverrideJson = customType<{ data: QuotaOverride | null; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (stored) => {
    try {
      const parsed = quotaOverrideSchema.safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON invalide : traité comme un format inconnu, ci-dessous.
    }
    console.error('quota_override illisible en base : quotas par défaut appliqués');
    return null;
  },
});

/** Réglages clé/valeur : `value` est du JSON validé par Zod, les champs secrets y sont chiffrés. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/**
 * Membres, identifiés par leur id Emby. `quotaOverride` : JSON `QuotaOverride`, `null` = quotas par défaut.
 * `lastLoginAt` : `null` tant que le membre (importé depuis Emby) ne s'est jamais connecté.
 */
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    avatar: text(),
    role: text({ enum: roles }).notNull().default('member'),
    quotaOverride: quotaOverrideJson(),
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastLoginAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    enumCheck('users_role_check', table.role, roles),
    check('users_quota_override_json_check', sql`${table.quotaOverride} IS NULL OR json_valid(${table.quotaOverride})`),
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
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    lastSeenAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    userAgent: text(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);

/**
 * Titres connus de l'appli (vus sur une affiche, dans Emby, Radarr ou Sonarr). Pas de titre ni d'affiche : TMDB reste
 * la source. `status` est un **cache** du statut de bibliothèque calculé par `services/availability.ts`
 * (`NULL` = absent : ni dans Emby ni chez Radarr/Sonarr), daté par `statusUpdatedAt` pour sa durée de vie.
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
    embyItemId: text(),
    status: text({ enum: mediaStatuses }),
    statusUpdatedAt: integer({ mode: 'timestamp' }).notNull(),
    /** Dernier calcul des saisons (série) ; `NULL` = jamais calculées, la fiche les calcule alors à la prochaine visite. */
    seasonsComputedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('media_type_check', table.type, mediaTypes),
    enumCheck('media_status_check', table.status, mediaStatuses),
    // Badge de chaque affiche : lecture par lot `WHERE (type, tmdb_id) IN (VALUES …)`.
    uniqueIndex('media_type_tmdb_id_unique').on(table.type, table.tmdbId),
    // Webhooks Radarr/Sonarr (tâche 5.1). Partiels : la plupart des titres n'ont aucun de ces ids.
    index('media_tvdb_id_idx').on(table.tvdbId).where(sql`${table.tvdbId} IS NOT NULL`),
    index('media_radarr_id_idx').on(table.radarrId).where(sql`${table.radarrId} IS NOT NULL`),
    index('media_sonarr_id_idx').on(table.sonarrId).where(sql`${table.sonarrId} IS NOT NULL`),
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
 * Exécutions des tâches de fond. Verrou : une seule ligne `running` par tâche (index unique partiel) ; démarrer
 * = insérer, une violation d'unicité signifie « déjà en cours ».
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer().primaryKey(),
    job: text().notNull(),
    status: text({ enum: jobRunStatuses }).notNull(),
    startedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt: integer({ mode: 'timestamp' }),
    detail: text(),
  },
  (table) => [
    enumCheck('job_runs_status_check', table.status, jobRunStatuses),
    // Littéral (pas de paramètre lié dans le DDL d'un index partiel).
    uniqueIndex('job_runs_running').on(table.job).where(sql`${table.status} = 'running'`),
    // « Dernier balayage » d'une tâche (`ORDER BY started_at DESC` parcourt l'index à rebours).
    index('job_runs_job_started_at_idx').on(table.job, table.startedAt),
  ],
);

/**
 * Demandes d'un membre (film, ou saisons d'une série dans `requestSeasons`). Profil, dossier et type de série sont
 * ceux choisis à l'approbation (`NULL` = valeur des réglages), repris tels quels par une relance.
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
    /** Réservé aux demandes 4K (toujours `false` pour l'instant). */
    is4k: integer('is_4k', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('requests_status_check', table.status, requestStatuses),
    enumCheck('requests_series_type_check', table.seriesType, seriesTypes),
    // Double clic : une seule demande avant envoi par membre et par titre (`onConflictDoNothing` sur cet index).
    uniqueIndex('requests_active')
      .on(table.mediaId, table.userId, table.is4k)
      .where(inLiterals(table.status, preSendRequestStatuses)),
    // « Mes demandes » et quota (fenêtre glissante sur `created_at`).
    index('requests_user_id_created_at_idx').on(table.userId, table.createdAt),
    // File d'approbation et compteur des demandes en attente.
    index('requests_status_created_at_idx').on(table.status, table.createdAt),
    // Statut affiché d'un titre (demandes par média) ; sert aussi la clé étrangère.
    index('requests_media_id_status_idx').on(table.mediaId, table.status),
    index('requests_decided_by_idx').on(table.decidedBy).where(sql`${table.decidedBy} IS NOT NULL`),
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
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    enumCheck('request_events_type_check', table.type, requestEventTypes),
    index('request_events_request_id_created_at_idx').on(table.requestId, table.createdAt),
    index('request_events_actor_id_idx').on(table.actorId).where(sql`${table.actorId} IS NOT NULL`),
  ],
);
