import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';

/** Niveaux d'un journal, du plus bavard au plus grave. */
export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

/** Entrées gardées en mémoire par le serveur (les plus anciennes sont écartées). */
export const LOG_CAPACITY = 1000;
export const LOGS_PATH = settingsPathOf('logs');

export const LOG_SEARCH_MAX_LENGTH = 100;
export const LOG_PAGE_MAX = 500;

/** Filtres de la liste : niveau minimal, texte cherché (message et contexte), nombre d'entrées. */
export const logsQuerySchema = z.object({
  level: z.enum(logLevels).default('debug'),
  q: z.string().trim().max(LOG_SEARCH_MAX_LENGTH).default(''),
  limit: z.coerce.number().int().min(1).max(LOG_PAGE_MAX).default(200),
});

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
  /** Autres champs de l'entrée (requête, statut, erreur), déjà expurgés des secrets. */
  context: string | null;
}

export interface LogList {
  entries: LogEntry[];
  /** Entrées en mémoire correspondant aux filtres, avant la limite. */
  matching: number;
}
