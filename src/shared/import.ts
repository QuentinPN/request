import { z } from 'zod';
import { serviceConnectionSchema } from './settings.ts';

/**
 * Import des demandes de Seerr (Jellyseerr, Overseerr), propriétaire seulement. Adresse et clé servent à cet appel
 * seulement : ni enregistrées, ni renvoyées. `?dryRun=1` : aperçu, rien n'est écrit.
 */
export const SEERR_IMPORT_PATH = '/api/import/seerr';

export const seerrImportSchema = serviceConnectionSchema;
export type SeerrImportInput = z.input<typeof seerrImportSchema>;

export const seerrImportQuerySchema = z.object({ dryRun: z.stringbool().default(false) });

/** Compte Seerr sans membre correspondant dans l'appli : ses demandes sont écartées. */
export interface SeerrUnmatchedUser {
  /** Id du compte dans Seerr ; `0` = demande sans compte lisible. */
  seerrId: number;
  name: string;
  requests: number;
}

/** Bilan d'un import, ou de son aperçu (`dryRun`) : mêmes règles, mêmes comptes. */
export interface SeerrImportResult {
  dryRun: boolean;
  /** Demandes lues dans Seerr. */
  total: number;
  /** Demandes créées (ou à créer, en aperçu). */
  imported: number;
  /** Déjà là : importées lors d'un import précédent, ou demande en cours du même membre sur le même titre. */
  alreadyPresent: number;
  unmatchedUsers: SeerrUnmatchedUser[];
  /** Demandes écartées faute de titre reconnaissable (id TMDB absent, type ou statut inconnu, aucune saison). */
  unmatchedMedia: number;
  /** Demandes 4K en attente ou en échec, écartées : l'appli n'a pas de Radarr/Sonarr 4K pour les envoyer. */
  skipped4k: number;
}
