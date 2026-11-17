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
