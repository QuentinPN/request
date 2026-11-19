import { z } from 'zod';
import { type BrowseFilters, type BrowseSort, DEFAULT_BROWSE_SORT } from '../../shared/catalogue.ts';
import {
  type CastMember,
  type CollectionDetails,
  type CollectionRef,
  type Credit,
  type CreditRole,
  type CrewJob,
  type CrewMember,
  type Genre,
  genreSchema,
  type MediaDetails,
  type MediaSearchResults,
  type MediaSummary,
  type MediaType,
  type Paged,
  type PersonDetails,
  type PersonSummary,
  type WatchProvider,
} from '../../shared/media.ts';
import type { Setting } from '../../shared/settings.ts';
import {
  DEFAULT_TMDB_LANGUAGE,
  DEFAULT_TMDB_REGION,
  languageCodeOf,
  type TmdbLanguage,
  type TmdbRegion,
} from '../../shared/tmdb-locale.ts';
import { TtlLru } from '../lib/lru.ts';
import { createClient, type RequestOptions } from './http.ts';

export { imageUrl } from '../../shared/media.ts';

export interface TmdbConfig extends Setting<'tmdb'> {
  /** Remplaçable pour les tests (défaut : l'API publique TMDB v3). */
  baseUrl?: string;
  /** Langue des titres et synopsis (défaut : `fr-FR`). */
  language?: TmdbLanguage;
  /** Région des sorties, dates de sortie et plateformes (défaut : `FR`). */
  region?: TmdbRegion;
}

const SERVICE = 'TMDB';
const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const FALLBACK_LANGUAGE = 'en-US';
const CAST_LIMIT = 15;
const CREW_LIMIT = 8;
/** Titres gardés par type dans la filmographie d'une personne (les plus populaires). */
const CREDITS_LIMIT = 60;
const LIST_TTL_MS = 60 * 60 * 1000;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const DETAILS_APPEND = 'credits,videos,recommendations,similar,watch/providers,external_ids,keywords';
/**
 * Séparateur de `without_keywords` : `|` (OU, comme pour `with_keywords`) exclut un titre qui porte l'un des mots-clés ;
 * la virgule (ET) n'exclurait que ceux qui les portent tous. Non documenté par TMDB pour `without_keywords`.
 */
const KEYWORD_OR = '|';

const MESSAGES = {
  unauthorized: 'Clé TMDB refusée',
  unreachable: 'TMDB injoignable',
  not_found: 'Introuvable sur TMDB',
};

/** Cache partagé par défaut : les réponses TMDB ne dépendent pas de la clé utilisée. */
const sharedCache = new TtlLru({ maxEntries: MAX_CACHE_ENTRIES });

// --- Réponses brutes de TMDB (seuls les champs utiles, tolérants aux absences) ---

const optionalString = z.string().nullish();
const rawMedia = z.object({
  id: z.number().int(),
  title: optionalString,
  original_title: optionalString,
  name: optionalString,
  release_date: optionalString,
  first_air_date: optionalString,
  poster_path: optionalString,
  backdrop_path: optionalString,
  overview: optionalString,
});
type RawMedia = z.infer<typeof rawMedia>;

const rawPage = <T extends z.ZodType>(item: T) =>
  z.object({ page: z.number().int(), total_pages: z.number().int(), results: z.array(item) });
const mediaPage = rawPage(rawMedia);

const rawSearchItem = rawMedia.extend({
  media_type: optionalString,
  profile_path: optionalString,
  known_for: z.array(rawMedia).nullish(),
});

const rawProvider = z.object({ provider_id: z.number().int(), provider_name: z.string(), logo_path: optionalString });
const rawProviders = z.object({
  flatrate: z.array(rawProvider).nullish(),
  rent: z.array(rawProvider).nullish(),
  buy: z.array(rawProvider).nullish(),
});

/** Plateformes de la région (`/watch/providers/{type}`) : `display_priorities` donne le rang par pays. */
const rawRegionProvider = rawProvider.extend({
  display_priority: z.number().nullish(),
  display_priorities: z.record(z.string(), z.number()).nullish(),
});

const rawCast = z.object({
  id: z.number().int(),
  name: z.string(),
  character: optionalString,
  profile_path: optionalString,
});
const rawCrew = z.object({
  id: z.number().int(),
  name: z.string(),
  job: optionalString,
  profile_path: optionalString,
});
const rawCollectionRef = z.object({
  id: z.number().int(),
  name: z.string(),
  poster_path: optionalString,
  backdrop_path: optionalString,
});
const rawVideo = z.object({ key: z.string(), site: optionalString, type: optionalString, iso_639_1: optionalString });
/** Mot-clé TMDB : `{ id, name }` (fiche, `/search/keyword`). */
const rawKeyword = z.object({ id: z.number().int(), name: z.string() });

const rawDetails = rawMedia.extend({
  original_language: optionalString,
  genres: z.array(genreSchema).nullish(),
  runtime: z.number().nullish(),
  seasons: z
    .array(z.object({ season_number: z.number().int(), episode_count: z.number().int(), air_date: optionalString }))
    .nullish(),
  last_episode_to_air: z.object({ season_number: z.number().int(), episode_number: z.number().int() }).nullish(),
  credits: z.object({ cast: z.array(rawCast), crew: z.array(rawCrew).nullish() }).nullish(),
  created_by: z.array(rawCrew).nullish(),
  belongs_to_collection: rawCollectionRef.nullish(),
  videos: z.object({ results: z.array(rawVideo) }).nullish(),
  recommendations: mediaPage.nullish(),
  similar: mediaPage.nullish(),
  'watch/providers': z.object({ results: z.record(z.string(), rawProviders) }).nullish(),
  external_ids: z.object({ imdb_id: optionalString, tvdb_id: z.number().int().nullish() }).nullish(),
  // Forme différente selon le type : `keywords.keywords` pour un film, `keywords.results` pour une série.
  keywords: z.object({ keywords: z.array(rawKeyword).nullish(), results: z.array(rawKeyword).nullish() }).nullish(),
});
type RawDetails = z.infer<typeof rawDetails>;

const rawCredit = rawMedia.extend({
  media_type: optionalString,
  popularity: z.number().nullish(),
  adult: z.boolean().nullish(),
});
const rawPerson = z.object({
  id: z.number().int(),
  name: z.string(),
  profile_path: optionalString,
  known_for_department: optionalString,
  birthday: optionalString,
  deathday: optionalString,
  place_of_birth: optionalString,
  biography: optionalString,
  combined_credits: z.object({ cast: z.array(rawCredit), crew: z.array(rawCredit) }).nullish(),
});
const rawCollection = z.object({
  id: z.number().int(),
  name: z.string(),
  overview: optionalString,
  poster_path: optionalString,
  backdrop_path: optionalString,
  parts: z.array(rawMedia),
});
/** Texte lu seul, pour compléter en anglais un champ vide en français. */
const rawEnglishText = z.object({ biography: optionalString, overview: optionalString });

// --- Normalisation ---

const yearOf = (date: string | null | undefined): number | null => {
  const year = Number.parseInt(date?.slice(0, 4) ?? '', 10);
  return year > 0 ? year : null;
};

function toSummary(raw: RawMedia, type: MediaType): MediaSummary {
  return {
    tmdbId: raw.id,
    type,
    title: raw.title || raw.name || '',
    year: yearOf(type === 'movie' ? raw.release_date : raw.first_air_date),
    posterPath: raw.poster_path || null,
    backdropPath: raw.backdrop_path || null,
    overview: raw.overview ?? '',
  };
}

const toProviders = (list: z.infer<typeof rawProvider>[] | null | undefined): WatchProvider[] =>
  (list ?? []).map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path || null }));

const toCast = (c: z.infer<typeof rawCast>): CastMember => ({
  id: c.id,
  name: c.name,
  character: c.character ?? '',
  profilePath: c.profile_path || null,
});

/** Métiers d'équipe mis en avant ; les autres (décors, montage…) sont ignorés. */
const CREW_JOBS: Record<string, CrewJob> = { Director: 'director', Screenplay: 'writer', Writer: 'writer' };

/** Réalisation et scénario (`credits.crew`), création (`created_by`, séries) : une entrée par personne, métiers réunis. */
function toCrew(raw: RawDetails): CrewMember[] {
  const byId = new Map<number, CrewMember>();
  const add = (person: z.infer<typeof rawCrew>, job: CrewJob | undefined) => {
    if (!job) return;
    const known = byId.get(person.id);
    if (!known)
      byId.set(person.id, { id: person.id, name: person.name, jobs: [job], profilePath: person.profile_path || null });
    else if (!known.jobs.includes(job)) known.jobs.push(job);
  };
  for (const person of raw.created_by ?? []) add(person, 'creator');
  for (const person of raw.credits?.crew ?? []) add(person, CREW_JOBS[person.job ?? '']);
  return [...byId.values()].slice(0, CREW_LIMIT);
}

const toCollectionRef = (raw: z.infer<typeof rawCollectionRef>): CollectionRef => ({
  id: raw.id,
  name: raw.name,
  posterPath: raw.poster_path || null,
  backdropPath: raw.backdrop_path || null,
});

/**
 * Filmographie : films et séries de `combined_credits`, une entrée par titre (rôle d'acteur et métiers d'équipe
 * réunis dans `roles`), les plus populaires d'abord, `CREDITS_LIMIT` par type.
 */
function toCredits(credits: NonNullable<z.infer<typeof rawPerson>['combined_credits']>) {
  const byKey = new Map<string, { raw: z.infer<typeof rawCredit>; type: MediaType; roles: Set<CreditRole> }>();
  for (const [list, role] of [
    [credits.cast, 'actor'],
    [credits.crew, 'crew'],
  ] as const) {
    for (const raw of list) {
      if (raw.adult || (raw.media_type !== 'movie' && raw.media_type !== 'tv')) continue;
      const key = `${raw.media_type}:${raw.id}`;
      const known = byKey.get(key) ?? { raw, type: raw.media_type, roles: new Set<CreditRole>() };
      known.roles.add(role);
      byKey.set(key, known);
    }
  }
  const popular = [...byKey.values()].sort((a, b) => (b.raw.popularity ?? 0) - (a.raw.popularity ?? 0));
  const ofType = (type: MediaType): Credit[] =>
    popular
      .filter((credit) => credit.type === type)
      .slice(0, CREDITS_LIMIT)
      .map(({ raw, roles }) => ({ ...toSummary(raw, type), roles: [...roles].sort() }));
  return { movies: ofType('movie'), shows: ofType('tv') };
}

const toPerson = (raw: z.infer<typeof rawPerson>, biography: string): PersonDetails => ({
  id: raw.id,
  name: raw.name,
  profilePath: raw.profile_path || null,
  knownForDepartment: raw.known_for_department || null,
  birthday: raw.birthday || null,
  deathday: raw.deathday || null,
  placeOfBirth: raw.place_of_birth || null,
  biography,
  ...toCredits(raw.combined_credits ?? { cast: [], crew: [] }),
});

/** Bande-annonce YouTube : dans la langue choisie d'abord, puis anglaise, puis la première disponible. */
function pickTrailerKey(videos: z.infer<typeof rawVideo>[] = [], language: TmdbLanguage): string | null {
  const trailers = videos.filter((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const code = languageCodeOf(language);
  const preferred = trailers.find((v) => v.iso_639_1 === code) ?? trailers.find((v) => v.iso_639_1 === 'en');
  return (preferred ?? trailers[0])?.key ?? null;
}

function toDetails(raw: RawDetails, type: MediaType, { language, region }: Locale): MediaDetails {
  const providers = raw['watch/providers']?.results[region];
  return {
    ...toSummary(raw, type),
    genres: raw.genres ?? [],
    runtime: raw.runtime || null,
    seasons: (raw.seasons ?? []).map((s) => ({
      seasonNumber: s.season_number,
      episodeCount: s.episode_count,
      airDate: s.air_date || null,
    })),
    cast: (raw.credits?.cast ?? []).slice(0, CAST_LIMIT).map(toCast),
    crew: toCrew(raw),
    collection: raw.belongs_to_collection ? toCollectionRef(raw.belongs_to_collection) : null,
    trailerKey: pickTrailerKey(raw.videos?.results, language),
    watchProviders: {
      flatrate: toProviders(providers?.flatrate),
      rent: toProviders(providers?.rent),
      buy: toProviders(providers?.buy),
    },
    recommendations: (raw.recommendations?.results ?? []).map((r) => toSummary(r, type)),
    similar: (raw.similar?.results ?? []).map((r) => toSummary(r, type)),
    externalIds: { imdb: raw.external_ids?.imdb_id || null, tvdb: raw.external_ids?.tvdb_id ?? null },
    keywords: (type === 'movie' ? raw.keywords?.keywords : raw.keywords?.results) ?? [],
    originalLanguage: raw.original_language || null,
    ...(raw.last_episode_to_air && {
      lastAired: {
        seasonNumber: raw.last_episode_to_air.season_number,
        episodeNumber: raw.last_episode_to_air.episode_number,
      },
    }),
  };
}

/** Sépare les résultats d'un flux mixte : films et séries d'un côté, personnes de l'autre ; le reste est ignoré. */
function splitMixed(items: z.infer<typeof rawSearchItem>[]) {
  const results: MediaSummary[] = [];
  const people: PersonSummary[] = [];
  for (const item of items) {
    if (item.media_type === 'movie' || item.media_type === 'tv') results.push(toSummary(item, item.media_type));
    else if (item.media_type === 'person')
      people.push({
        id: item.id,
        name: item.name ?? '',
        profilePath: item.profile_path || null,
        knownFor: (item.known_for ?? []).map((k) => k.title || k.name || '').filter(Boolean),
      });
  }
  return { results, people };
}

const toPaged = (raw: z.infer<typeof mediaPage>, type: MediaType): Paged<MediaSummary> => ({
  page: raw.page,
  totalPages: raw.total_pages,
  results: raw.results.map((r) => toSummary(r, type)),
});

// --- Client ---

/** Jeton de lecture v4 (JWT, commence par `eyJ`) → en-tête Bearer ; sinon clé v3 → paramètre `api_key`. */
const isReadToken = (apiKey: string) => apiKey.startsWith('eyJ');

function newClient({ apiKey, baseUrl = DEFAULT_BASE_URL }: TmdbConfig) {
  return createClient({
    service: SERVICE,
    baseUrl,
    messages: MESSAGES,
    ...(isReadToken(apiKey) ? { headers: { authorization: `Bearer ${apiKey}` } } : { query: { api_key: apiKey } }),
  });
}

type Query = NonNullable<RequestOptions['query']>;
type Locale = { language: TmdbLanguage; region: TmdbRegion };

/** Plancher de votes de TMDB pour la note : sans lui, un titre à 10/10 avec un seul vote passerait en tête. */
const MIN_VOTES_FOR_RATING = 200;
/** Filtre « abonnement » de la région : mêmes paramètres pour la page d'une plateforme et pour les filtres. */
const providerParams = (providerId: number, region: TmdbRegion): Query => ({
  with_watch_providers: providerId,
  watch_region: region,
  with_watch_monetization_types: 'flatrate',
});
/** Tri des filtres : noms de TMDB, différents pour les films et les séries. */
const SORT_BY: Record<BrowseSort, Record<MediaType, string>> = {
  popularity: { movie: 'popularity.desc', tv: 'popularity.desc' },
  rating: { movie: 'vote_average.desc', tv: 'vote_average.desc' },
  release: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  title: { movie: 'title.asc', tv: 'name.asc' },
};

/**
 * Paramètres `/discover/{type}` des filtres de Films et Séries (hors page et mots-clés bloqués). Genres multiples :
 * `,` = ET (le titre a tous les genres). Durée et studio ne valent que pour les films, chaîne que pour les séries.
 */
export function browseParams(type: MediaType, f: BrowseFilters, region: TmdbRegion = DEFAULT_TMDB_REGION): Query {
  const dateKey = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  const sort = f.sort ?? DEFAULT_BROWSE_SORT;
  return {
    sort_by: SORT_BY[sort][type],
    ...(f.genres !== undefined && f.genres.length > 0 && { with_genres: f.genres.join(',') }),
    ...(f.yearFrom !== undefined && { [`${dateKey}.gte`]: `${f.yearFrom}-01-01` }),
    ...(f.yearTo !== undefined && { [`${dateKey}.lte`]: `${f.yearTo}-12-31` }),
    ...(f.rating !== undefined && { 'vote_average.gte': f.rating }),
    ...((f.rating !== undefined || sort === 'rating') && { 'vote_count.gte': MIN_VOTES_FOR_RATING }),
    ...(type === 'movie' && f.runtimeMin !== undefined && { 'with_runtime.gte': f.runtimeMin }),
    ...(type === 'movie' && f.runtimeMax !== undefined && { 'with_runtime.lte': f.runtimeMax }),
    ...(f.language !== undefined && { with_original_language: f.language }),
    ...(f.provider !== undefined && providerParams(f.provider, region)),
    ...(type === 'movie' && f.company !== undefined && { with_companies: f.company }),
    ...(type === 'tv' && f.network !== undefined && { with_networks: f.network }),
  };
}

/** Vérifie la clé (v3 ou jeton v4) ; lève une `IntegrationError` au message lisible (« Clé TMDB refusée »…) en cas d'échec. */
export async function testTmdb(config: TmdbConfig): Promise<{ ok: true }> {
  await newClient(config).get('/configuration', z.object({ images: z.object({ base_url: z.string() }) }));
  return { ok: true };
}

/**
 * Accès à TMDB dans la langue et la région du réglage (`fr-FR` et `FR` par défaut). Toutes les requêtes GET sont
 * mémorisées par adresse (clé secrète exclue ; la langue et la région y figurent, un changement de réglage ne sert
 * donc jamais l'ancienne langue) : ~1 h pour les listes, ~6 h pour les fiches ; deux demandes identiques simultanées
 * partagent un seul appel.
 */
export function createTmdb(config: TmdbConfig, cache: TtlLru = sharedCache) {
  const client = newClient(config);
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const language = config.language ?? DEFAULT_TMDB_LANGUAGE;
  const region = config.region ?? DEFAULT_TMDB_REGION;

  const get = <T>(path: string, schema: z.ZodType<T>, query: Query, ttlMs: number): Promise<T> => {
    const params: Query = { language, ...query };
    const search = new URLSearchParams(
      Object.entries(params)
        .flatMap(([name, value]): [string, string][] => (value === undefined ? [] : [[name, String(value)]]))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return cache.getOrLoad(`${baseUrl}${path}?${search}`, ttlMs, () => client.get(path, schema, { query: params }));
  };

  /** Biographie ou synopsis vide en français, relu en anglais ; au mieux : un échec laisse le texte vide. */
  const englishText = async (path: string, field: 'biography' | 'overview'): Promise<string> => {
    if (languageCodeOf(language) === 'en') return '';
    try {
      return (await get(path, rawEnglishText, { language: FALLBACK_LANGUAGE }, DETAILS_TTL_MS))[field] ?? '';
    } catch {
      return '';
    }
  };

  const list = async (type: MediaType, path: string, query: Query = {}) =>
    toPaged(await get(path, mediaPage, query, LIST_TTL_MS), type);

  /** `/discover`, le seul flux qui sait écarter des mots-clés (`exclude`, ids TMDB) côté TMDB. */
  const discover = (type: MediaType, page: number, filters: Query, exclude: readonly number[] = []) =>
    list(type, `/discover/${type}`, {
      sort_by: 'popularity.desc',
      page,
      ...filters,
      ...(exclude.length > 0 && { without_keywords: exclude.join(KEYWORD_OR) }),
    });

  return {
    trending: async (type: MediaType, window: 'day' | 'week'): Promise<MediaSummary[]> =>
      (await list(type, `/trending/${type}/${window}`)).results,

    /** Films et séries mélangés, dans l'ordre de TMDB (les personnes sont écartées). */
    trendingAll: async (window: 'day' | 'week'): Promise<MediaSummary[]> =>
      splitMixed((await get(`/trending/all/${window}`, rawPage(rawSearchItem), {}, LIST_TTL_MS)).results).results,

    popular: async (type: MediaType): Promise<MediaSummary[]> => (await list(type, `/${type}/popular`)).results,

    /** Films à venir dans la région. */
    upcoming: async (): Promise<MediaSummary[]> => (await list('movie', '/movie/upcoming', { region })).results,

    /** Séries actuellement diffusées. */
    onTheAir: async (): Promise<MediaSummary[]> => (await list('tv', '/tv/on_the_air')).results,

    /** Titres disponibles en streaming (abonnement) chez une plateforme, dans la région ; sans les mots-clés `exclude`. */
    discoverByProvider: (type: MediaType, providerId: number, page = 1, exclude?: readonly number[]) =>
      discover(type, page, providerParams(providerId, region), exclude),

    /** Films ou séries selon les filtres de la page (voir `browseParams`) ; sans les mots-clés `exclude`. */
    browse: (type: MediaType, filters: BrowseFilters, page = 1, exclude?: readonly number[]) =>
      discover(type, page, browseParams(type, filters, region), exclude),

    /** Mots-clés TMDB dont le nom correspond (Réglages › Blocages), première page. */
    searchKeywords: async (query: string): Promise<Array<{ id: number; name: string }>> =>
      (await get('/search/keyword', rawPage(rawKeyword), { query, page: 1 }, LIST_TTL_MS)).results,

    genres: async (type: MediaType): Promise<Genre[]> =>
      (await get(`/genre/${type}/list`, z.object({ genres: z.array(genreSchema) }), {}, DETAILS_TTL_MS)).genres,

    /**
     * Plateformes de streaming de la région, les plus en vue d'abord. TMDB ne filtre pas ici par mode
     * (abonnement, location, achat) : le filtre « abonnement » s'applique à `discoverByProvider`.
     */
    providers: async (type: MediaType): Promise<WatchProvider[]> => {
      const raw = await get(
        `/watch/providers/${type}`,
        z.object({ results: z.array(rawRegionProvider) }),
        { watch_region: region },
        DETAILS_TTL_MS,
      );
      const rank = (p: z.infer<typeof rawRegionProvider>) =>
        p.display_priorities?.[region] ?? p.display_priority ?? Number.MAX_SAFE_INTEGER;
      return toProviders([...raw.results].sort((a, b) => rank(a) - rank(b)));
    },

    /** Films et séries (un seul flux paginé) et personnes (à part) ; les autres types sont ignorés. */
    searchMulti: async (query: string, page = 1): Promise<MediaSearchResults> => {
      const raw = await get('/search/multi', rawPage(rawSearchItem), { query, page }, LIST_TTL_MS);
      return { page: raw.page, totalPages: raw.total_pages, ...splitMixed(raw.results) };
    },

    /** Fiche complète ; si le titre ou le synopsis manquent en français, ils sont complétés en anglais (un seul appel, au mieux). */
    details: async (type: MediaType, id: number): Promise<MediaDetails> => {
      const path = `/${type}/${id}`;
      const query = {
        append_to_response: DETAILS_APPEND,
        include_video_language: `${languageCodeOf(language)},en,null`,
      };
      const details = toDetails(await get(path, rawDetails, query, DETAILS_TTL_MS), type, { language, region });
      if ((details.title && details.overview) || languageCodeOf(language) === 'en') return details;
      try {
        const english = toSummary(await get(path, rawMedia, { language: FALLBACK_LANGUAGE }, DETAILS_TTL_MS), type);
        return { ...details, title: details.title || english.title, overview: details.overview || english.overview };
      } catch {
        return details; // repli au mieux : la fiche française reste valable
      }
    },

    /** Personne et sa filmographie. */
    person: async (id: number): Promise<PersonDetails> => {
      const path = `/person/${id}`;
      const raw = await get(path, rawPerson, { append_to_response: 'combined_credits' }, DETAILS_TTL_MS);
      return toPerson(raw, raw.biography || (await englishText(path, 'biography')));
    },

    /** Saga et ses films, du plus ancien au plus récent (sans date : à la fin). */
    collection: async (id: number): Promise<CollectionDetails> => {
      const path = `/collection/${id}`;
      const raw = await get(path, rawCollection, {}, DETAILS_TTL_MS);
      const date = (part: z.infer<typeof rawMedia>) => part.release_date || '9999';
      return {
        id: raw.id,
        name: raw.name,
        overview: raw.overview || (await englishText(path, 'overview')),
        posterPath: raw.poster_path || null,
        backdropPath: raw.backdrop_path || null,
        parts: [...raw.parts].sort((a, b) => date(a).localeCompare(date(b))).map((part) => toSummary(part, 'movie')),
      };
    },

    /** Résumé d'un titre (affiche, année, synopsis), sans le reste de la fiche. */
    summary: async (type: MediaType, id: number): Promise<MediaSummary> =>
      toSummary(await get(`/${type}/${id}`, rawMedia, {}, DETAILS_TTL_MS), type),

    /**
     * Films dont le titre correspond à la recherche, dans l'ordre de TMDB, avec leur titre original (les titres
     * d'autres langues, comme ceux de Letterboxd, y sont rapprochés). Sans filtre d'année : c'est l'appelant qui
     * juge, une sortie en festival ou à l'étranger décalant souvent l'année d'un an.
     */
    searchMovies: async (query: string): Promise<Array<MediaSummary & { originalTitle: string }>> =>
      (await get('/search/movie', mediaPage, { query }, LIST_TTL_MS)).results.map((raw) => ({
        ...toSummary(raw, 'movie'),
        originalTitle: raw.original_title ?? '',
      })),

    /** Identifiant TVDB d'une série (Sonarr), `null` si TMDB ne le connaît pas. */
    tvdbIdFor: async (tvId: number): Promise<number | null> => {
      const ids = await get(
        `/tv/${tvId}/external_ids`,
        z.object({ tvdb_id: z.number().int().nullish() }),
        {},
        DETAILS_TTL_MS,
      );
      return ids.tvdb_id ?? null;
    },
  };
}

export type TmdbClient = ReturnType<typeof createTmdb>;
