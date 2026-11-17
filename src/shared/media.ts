import { z } from 'zod';

export const mediaTypeSchema = z.enum(['movie', 'tv']);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/** Média normalisé tel qu'il est envoyé au client (film ou série, issu de TMDB). */
export const mediaSummarySchema = z.object({
  tmdbId: z.number().int(),
  type: mediaTypeSchema,
  title: z.string(),
  year: z.number().int().nullable(),
  posterPath: z.string().nullable(),
  backdropPath: z.string().nullable(),
  overview: z.string(),
});
export type MediaSummary = z.infer<typeof mediaSummarySchema>;

export const genreSchema = z.object({ id: z.number().int(), name: z.string() });
export type Genre = z.infer<typeof genreSchema>;

export const seasonSchema = z.object({
  seasonNumber: z.number().int(),
  episodeCount: z.number().int(),
  airDate: z.string().nullable(),
});
export type Season = z.infer<typeof seasonSchema>;

export const castMemberSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  character: z.string(),
  profilePath: z.string().nullable(),
});
export type CastMember = z.infer<typeof castMemberSchema>;

export const watchProviderSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  logoPath: z.string().nullable(),
});
export type WatchProvider = z.infer<typeof watchProviderSchema>;

export const mediaDetailsSchema = mediaSummarySchema.extend({
  genres: z.array(genreSchema),
  /** Durée en minutes (films) ; `null` pour une série. */
  runtime: z.number().int().nullable(),
  /** Saisons (séries) ; vide pour un film. */
  seasons: z.array(seasonSchema),
  /** 15 premiers rôles. */
  cast: z.array(castMemberSchema),
  /** Clé YouTube de la bande-annonce. */
  trailerKey: z.string().nullable(),
  /** Où regarder, en France. */
  watchProviders: z.object({
    flatrate: z.array(watchProviderSchema),
    rent: z.array(watchProviderSchema),
    buy: z.array(watchProviderSchema),
  }),
  recommendations: z.array(mediaSummarySchema),
  similar: z.array(mediaSummarySchema),
  externalIds: z.object({ imdb: z.string().nullable(), tvdb: z.number().int().nullable() }),
});
export type MediaDetails = z.infer<typeof mediaDetailsSchema>;

export const personSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  profilePath: z.string().nullable(),
  /** Titres pour lesquels la personne est connue. */
  knownFor: z.array(z.string()),
});
export type PersonSummary = z.infer<typeof personSummarySchema>;

/** Une page de résultats (le `page` de TMDB commence à 1). */
export interface Paged<T> {
  page: number;
  totalPages: number;
  results: T[];
}

/** Résultat d'une recherche globale : films et séries paginés, personnes à part. */
export interface MediaSearchResults extends Paged<MediaSummary> {
  people: PersonSummary[];
}

export const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
export const IMAGE_SIZES = { poster: 'w342', backdrop: 'w1280', profile: 'w185' } as const;
export type ImageKind = keyof typeof IMAGE_SIZES;

/** Adresse d'une image TMDB (`null` si le média n'en a pas). */
export function imageUrl(path: string | null | undefined, kind: ImageKind): string | null {
  return path ? `${IMAGE_BASE_URL}/${IMAGE_SIZES[kind]}${path}` : null;
}
