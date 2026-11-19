import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';
import { requestStatusSchema } from './status.ts';

/** Titre de l'appli tant que le propriétaire n'en a pas choisi un : onglet du navigateur et textes envoyés aux membres. */
export const DEFAULT_APP_TITLE = 'Request';
export const APP_TITLE_MAX = 40;
export const appTitleSchema = z
  .string()
  .trim()
  .min(1, 'Titre requis')
  .regex(/^[^\p{Cc}]+$/u, 'Sans saut de ligne ni caractère de contrôle')
  .max(APP_TITLE_MAX, `${APP_TITLE_MAX} caractères au plus`);

/** Réglages Général (propriétaire) ; le titre lui-même est public, il part avec l'état de l'installation. */
export const GENERAL_SETTINGS_PATH = settingsPathOf('general');

/** Réglages › À propos (propriétaire seulement) : un seul endpoint, en lecture seule. */
export const ABOUT_PATH = '/api/about';

const count = z.number().int().min(0);

export const aboutSchema = z.object({
  version: z.string(),
  /** Commit de l'image (`GIT_SHA`, fixé au build), `null` hors image publiée. */
  commit: z.string().nullable(),
  node: z.string(),
  uptimeSeconds: count,
  timeZone: z.string(),
  dataDir: z.string(),
  /** Fichier de la base SQLite et son journal (-wal), en octets. */
  databaseBytes: count,
  counts: z.object({
    members: count,
    media: count,
    requests: count,
    /** Tous les statuts sont présents, à 0 s'il n'y a aucune demande. */
    requestsByStatus: z.record(requestStatusSchema, count),
  }),
});
export type About = z.infer<typeof aboutSchema>;
