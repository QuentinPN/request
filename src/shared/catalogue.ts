import { z } from 'zod';
import {
  genreSchema,
  imageSizeSchema,
  mediaSummarySchema,
  mediaTypeSchema,
  pagedSchema,
  watchProviderSchema,
} from './media.ts';

// --- Paramètres de requête (validés côté serveur, réutilisables par le client) ---

const positiveInt = z.coerce.number().int().positive();

/** `?page=` : TMDB ne pagine pas au-delà de 500. */
export const pageQuerySchema = z.object({ page: positiveInt.max(500).default(1) });
export const searchQuerySchema = pageQuerySchema.extend({ q: z.string().trim().min(1).max(100) });

export const typeParamsSchema = z.object({ type: mediaTypeSchema });
export const typeIdParamsSchema = typeParamsSchema.extend({ id: positiveInt });

/** Réglage `discover` (masquer disponibles / déjà demandés), propriétaire seulement. */
export const DISCOVER_SETTINGS_PATH = '/api/settings/discover';

// --- Réponses ---

export const discoverRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  items: z.array(mediaSummarySchema),
});
export type DiscoverRow = z.infer<typeof discoverRowSchema>;

export const discoverResponseSchema = z.object({ rows: z.array(discoverRowSchema) });
export type DiscoverResponse = z.infer<typeof discoverResponseSchema>;

export const pagedMediaSchema = pagedSchema(mediaSummarySchema);

export const genresResponseSchema = z.object({ genres: z.array(genreSchema) });
export type GenresResponse = z.infer<typeof genresResponseSchema>;

export const providersResponseSchema = z.object({ providers: z.array(watchProviderSchema) });
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

// --- Images ---

/** Nom de fichier TMDB (`abc123.jpg`) : ni séparateur ni `..`, donc aucun parcours de dossiers possible. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const imageFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|svg)$/)
  // Noms réservés de Windows (`con.jpg`…) : ils ne désignent pas un fichier ordinaire.
  .refine((file) => !WINDOWS_RESERVED.test(file.slice(0, file.lastIndexOf('.'))));
export const imageParamsSchema = z.object({ size: imageSizeSchema, file: imageFileSchema });
