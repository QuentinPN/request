import { z } from 'zod';
import { availabilitySchema, titleAvailabilitySchema } from './status.ts';

export const mediaTypes = ['movie', 'tv'] as const;
export const mediaTypeSchema = z.enum(mediaTypes);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export interface MediaKey {
  type: MediaType;
  tmdbId: number;
}
/** Clé unique d'un média (`movie:123`), partagée par les intégrations et les services. */
export const keyOf = ({ type, tmdbId }: MediaKey) => `${type}:${tmdbId}`;

/**
 * Média normalisé tel qu'il est envoyé au client (film ou série, issu de TMDB), avec son statut calculé par le
 * serveur (`status` absent : ni dans la bibliothèque ni demandé).
 */
/**
 * Titre bloqué (Réglages › Blocages) : par la liste des titres, ou par un mot-clé TMDB bloqué (fiche seulement, seule à
 * lire les mots-clés). Absent : demandable.
 */
export const mediaBlockSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('title') }),
  z.object({ by: z.literal('keyword'), keyword: z.string() }),
]);
export type MediaBlock = z.infer<typeof mediaBlockSchema>;

export const mediaSummarySchema = z
  .object({
    tmdbId: z.number().int(),
    type: mediaTypeSchema,
    title: z.string(),
    year: z.number().int().nullable(),
    posterPath: z.string().nullable(),
    backdropPath: z.string().nullable(),
    overview: z.string(),
    /** Posé par le serveur pour qui gère les blocages (les membres ne voient pas les titres bloqués dans les listes). */
    blocked: mediaBlockSchema.optional(),
  })
  .extend(titleAvailabilitySchema.shape);
export type MediaSummary = z.infer<typeof mediaSummarySchema>;

export const genreSchema = z.object({ id: z.number().int(), name: z.string() });
export type Genre = z.infer<typeof genreSchema>;

/** Épisodes présents et attendus (diffusés) quand la saison a un statut : « 8/10 épisodes ». */
const episodesSchema = z.object({ present: z.number().int(), expected: z.number().int() }).optional();

/**
 * Statut 4K d'un titre ou d'une saison, calculé depuis les seuls serveurs 4K ; absent quand aucun serveur 4K du type
 * n'existe (ni pastille ni « Demander en 4K »).
 */
const fourKSchema = availabilitySchema.extend({ episodes: episodesSchema }).optional();

/** Saison d'une série, avec son statut propre (fiche titre). */
export const seasonSchema = z
  .object({
    seasonNumber: z.number().int(),
    episodeCount: z.number().int(),
    airDate: z.string().nullable(),
    episodes: episodesSchema,
    fourK: fourKSchema,
  })
  .extend(availabilitySchema.shape);
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
  fourK: fourKSchema,
  /** Mots-clés TMDB (blocage par mot-clé) ; usage serveur. */
  keywords: z.array(genreSchema).optional(),
  /** Série : dernier épisode diffusé (TMDB), pour compter les épisodes attendus d'une saison en cours ; usage serveur. */
  lastAired: z.object({ seasonNumber: z.number().int(), episodeNumber: z.number().int() }).nullish(),
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
export const pagedSchema = <T extends z.ZodType>(item: T) =>
  z.object({ page: z.number().int(), totalPages: z.number().int(), results: z.array(item) });

/** Résultat d'une recherche globale : films et séries paginés, personnes à part. */
export const mediaSearchResultsSchema = pagedSchema(mediaSummarySchema).extend({
  people: z.array(personSummarySchema),
});
export type MediaSearchResults = z.infer<typeof mediaSearchResultsSchema>;

/** Tailles d'image acceptées par le proxy d'images (celles de TMDB). */
export const imageSizeSchema = z.enum(['w185', 'w342', 'w500', 'w780', 'w1280', 'original']);
export type ImageSize = z.infer<typeof imageSizeSchema>;

/** Les images sont servies par l'appli (proxy avec cache disque) : le navigateur n'appelle jamais TMDB. */
export const IMAGE_BASE_URL = '/api/images';
export const IMAGE_SIZES = { poster: 'w342', backdrop: 'w1280', profile: 'w185' } as const satisfies Record<
  string,
  ImageSize
>;
export type ImageKind = keyof typeof IMAGE_SIZES;

/** Adresse d'une image TMDB, servie par l'appli (`null` si le média n'en a pas). */
export function imageUrl(path: string | null | undefined, kind: ImageKind): string | null {
  return path ? `${IMAGE_BASE_URL}/${IMAGE_SIZES[kind]}${path}` : null;
}
