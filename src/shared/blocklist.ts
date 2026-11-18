import { z } from 'zod';
import { mediaTypeSchema } from './media.ts';

/** Mot-clé TMDB bloqué (réglage `blockedKeywords`) : l'id sert à `without_keywords`, le nom à l'affichage. */
export const blockedKeywordSchema = z.object({ id: z.number().int().positive(), name: z.string().trim().min(1) });
export type BlockedKeyword = z.output<typeof blockedKeywordSchema>;

/** Titre bloqué (table `blocked_titles`) : non demandable, retiré de Découvrir et de la recherche des membres. */
export const blockedTitleSchema = z.object({
  mediaType: mediaTypeSchema,
  tmdbId: z.number().int().positive(),
  title: z.string(),
  /** Nom du gestionnaire qui l'a bloqué ; `null` s'il n'existe plus. */
  blockedBy: z.string().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type BlockedTitle = z.output<typeof blockedTitleSchema>;

// --- Routes (droit « Gérer les blocages ») ---

export const BLOCKLIST_PATH = '/api/blocklist';
export const BLOCKED_TITLES_PATH = `${BLOCKLIST_PATH}/titles`;
export const BLOCKED_TITLE_ROUTE = `${BLOCKED_TITLES_PATH}/:type/:id`;
export const blockedTitlePath = (type: string, tmdbId: number) => `${BLOCKED_TITLES_PATH}/${type}/${tmdbId}`;
export const BLOCKED_KEYWORDS_PATH = `${BLOCKLIST_PATH}/keywords`;
/** Recherche de mots-clés TMDB (`?q=`), pour en ajouter. */
export const KEYWORD_SEARCH_PATH = `${BLOCKED_KEYWORDS_PATH}/search`;

/** Bloquer un titre : le serveur lit lui-même son nom sur TMDB. */
export const blockTitleSchema = z.object({ mediaType: mediaTypeSchema, tmdbId: z.number().int().positive() });
export type BlockTitleInput = z.input<typeof blockTitleSchema>;

export const keywordSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });

export interface Blocklist {
  /** Plus récents d'abord. */
  titles: BlockedTitle[];
  keywords: BlockedKeyword[];
}
