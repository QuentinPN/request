import { z } from 'zod';
import { mediaTypeSchema } from './media.ts';

/** Origine d'un titre de la liste de souhaits : ajouté dans l'appli, ou importé d'une liste Trakt ou Letterboxd. */
export const watchlistSources = ['manual', 'trakt', 'letterboxd'] as const;
export type WatchlistSource = (typeof watchlistSources)[number];
export const watchlistSourceSchema = z.enum(watchlistSources);

/**
 * Titre de la liste d'un membre (unique par membre et titre). Titre, année et affiche sont une copie pour l'affichage
 * (facultatifs) : TMDB reste la source.
 */
export const watchlistItemSchema = z.object({
  mediaType: mediaTypeSchema,
  tmdbId: z.number().int().positive(),
  title: z.string().nullable(),
  year: z.number().int().nullable(),
  posterPath: z.string().nullable(),
  source: watchlistSourceSchema,
  /** ISO 8601. */
  addedAt: z.string(),
});
export type WatchlistItem = z.output<typeof watchlistItemSchema>;
