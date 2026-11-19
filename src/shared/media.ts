import { z } from 'zod';
import { availabilitySchema, titleAvailabilitySchema } from './status.ts';

export const mediaTypes = ['movie', 'tv'] as const;
export const mediaTypeSchema = z.enum(mediaTypes);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const mediaKeySchema = z.object({ type: mediaTypeSchema, tmdbId: z.number().int() });
export type MediaKey = z.infer<typeof mediaKeySchema>;
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

/** Métiers de l'équipe mis en avant sur la fiche (libellés français côté client). */
export const crewJobs = ['director', 'writer', 'creator'] as const;
export const crewJobSchema = z.enum(crewJobs);
export type CrewJob = z.infer<typeof crewJobSchema>;

export const crewMemberSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  jobs: z.array(crewJobSchema),
  profilePath: z.string().nullable(),
});
export type CrewMember = z.infer<typeof crewMemberSchema>;

/** Saga (collection TMDB) à laquelle appartient un film. */
export const collectionRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  posterPath: z.string().nullable(),
  backdropPath: z.string().nullable(),
});
export type CollectionRef = z.infer<typeof collectionRefSchema>;

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
  /** Équipe clé (réalisation, scénario, création), 8 personnes au plus. */
  crew: z.array(crewMemberSchema).optional(),
  /** Film : saga à laquelle il appartient. */
  collection: collectionRefSchema.nullish(),
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
  /** Langue originale TMDB (ISO 639-1) : règles de surcharge ; usage serveur. */
  originalLanguage: z.string().nullish(),
  /** Série : dernier épisode diffusé (TMDB), pour compter les épisodes attendus d'une saison en cours ; usage serveur. */
  lastAired: z.object({ seasonNumber: z.number().int(), episodeNumber: z.number().int() }).nullish(),
});
export type MediaDetails = z.infer<typeof mediaDetailsSchema>;

/** Mot-clé TMDB « anime » : celui que Seerr utilise pour router une série vers les réglages anime de Sonarr. */
export const ANIME_KEYWORD_ID = 210024;
export const isAnime = ({ keywords }: Pick<MediaDetails, 'keywords'>) =>
  keywords?.some((keyword) => keyword.id === ANIME_KEYWORD_ID) ?? false;

export const personSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  profilePath: z.string().nullable(),
  /** Titres pour lesquels la personne est connue. */
  knownFor: z.array(z.string()),
});
export type PersonSummary = z.infer<typeof personSummarySchema>;

/** Titre de la filmographie d'une personne : « actor » (distribution) et/ou « crew » (équipe). */
export const creditRoleSchema = z.enum(['actor', 'crew']);
export type CreditRole = z.infer<typeof creditRoleSchema>;
export const creditSchema = mediaSummarySchema.extend({ roles: z.array(creditRoleSchema) });
export type Credit = z.infer<typeof creditSchema>;

/** Page d'une personne : fiche et filmographie (films et séries, les plus populaires d'abord), statuts compris. */
export const personDetailsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  profilePath: z.string().nullable(),
  /** Service de TMDB en anglais (`Acting`, `Directing`…), traduit par le client. */
  knownForDepartment: z.string().nullable(),
  birthday: z.string().nullable(),
  deathday: z.string().nullable(),
  placeOfBirth: z.string().nullable(),
  biography: z.string(),
  movies: z.array(creditSchema),
  shows: z.array(creditSchema),
});
export type PersonDetails = z.infer<typeof personDetailsSchema>;

/** Saga : films triés par date de sortie, sans date en dernier. */
export const collectionDetailsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  overview: z.string(),
  posterPath: z.string().nullable(),
  backdropPath: z.string().nullable(),
  parts: z.array(mediaSummarySchema),
});
export type CollectionDetails = z.infer<typeof collectionDetailsSchema>;

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
