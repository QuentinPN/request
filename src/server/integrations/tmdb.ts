import { z } from 'zod';
import {
  type CastMember,
  type Genre,
  genreSchema,
  type MediaDetails,
  type MediaSearchResults,
  type MediaSummary,
  type MediaType,
  type Paged,
  type PersonSummary,
  type WatchProvider,
} from '../../shared/media.ts';
import type { Setting } from '../../shared/settings.ts';
import { TtlLru } from '../lib/lru.ts';
import { createClient, type RequestOptions } from './http.ts';

export { imageUrl } from '../../shared/media.ts';

export interface TmdbConfig extends Setting<'tmdb'> {
  /** Remplaçable pour les tests (défaut : l'API publique TMDB v3). */
  baseUrl?: string;
}

const SERVICE = 'TMDB';
const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const LANGUAGE = 'fr-FR';
const FALLBACK_LANGUAGE = 'en-US';
const REGION = 'FR';
const CAST_LIMIT = 15;
const LIST_TTL_MS = 60 * 60 * 1000;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const DETAILS_APPEND = 'credits,videos,recommendations,similar,watch/providers,external_ids';

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
const rawVideo = z.object({ key: z.string(), site: optionalString, type: optionalString, iso_639_1: optionalString });

const rawDetails = rawMedia.extend({
  genres: z.array(genreSchema).nullish(),
  runtime: z.number().nullish(),
  seasons: z
    .array(z.object({ season_number: z.number().int(), episode_count: z.number().int(), air_date: optionalString }))
    .nullish(),
  credits: z.object({ cast: z.array(rawCast) }).nullish(),
  videos: z.object({ results: z.array(rawVideo) }).nullish(),
  recommendations: mediaPage.nullish(),
  similar: mediaPage.nullish(),
  'watch/providers': z.object({ results: z.record(z.string(), rawProviders) }).nullish(),
  external_ids: z.object({ imdb_id: optionalString, tvdb_id: z.number().int().nullish() }).nullish(),
});
type RawDetails = z.infer<typeof rawDetails>;

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

/** Bande-annonce YouTube : française d'abord, puis anglaise, puis la première disponible. */
function pickTrailerKey(videos: z.infer<typeof rawVideo>[] = []): string | null {
  const trailers = videos.filter((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const preferred = trailers.find((v) => v.iso_639_1 === 'fr') ?? trailers.find((v) => v.iso_639_1 === 'en');
  return (preferred ?? trailers[0])?.key ?? null;
}

function toDetails(raw: RawDetails, type: MediaType): MediaDetails {
  const providers = raw['watch/providers']?.results[REGION];
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
    trailerKey: pickTrailerKey(raw.videos?.results),
    watchProviders: {
      flatrate: toProviders(providers?.flatrate),
      rent: toProviders(providers?.rent),
      buy: toProviders(providers?.buy),
    },
    recommendations: (raw.recommendations?.results ?? []).map((r) => toSummary(r, type)),
    similar: (raw.similar?.results ?? []).map((r) => toSummary(r, type)),
    externalIds: { imdb: raw.external_ids?.imdb_id || null, tvdb: raw.external_ids?.tvdb_id ?? null },
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

/** Vérifie la clé (v3 ou jeton v4) ; lève une `IntegrationError` au message lisible (« Clé TMDB refusée »…) en cas d'échec. */
export async function testTmdb(config: TmdbConfig): Promise<{ ok: true }> {
  await newClient(config).get('/configuration', z.object({ images: z.object({ base_url: z.string() }) }));
  return { ok: true };
}

/**
 * Accès à TMDB (fr-FR, région FR). Toutes les requêtes GET sont mémorisées par adresse (clé secrète exclue) :
 * ~1 h pour les listes, ~6 h pour les fiches ; deux demandes identiques simultanées partagent un seul appel.
 */
export function createTmdb(config: TmdbConfig, cache: TtlLru = sharedCache) {
  const client = newClient(config);
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  const get = <T>(path: string, schema: z.ZodType<T>, query: Query, ttlMs: number): Promise<T> => {
    const params: Query = { language: LANGUAGE, ...query };
    const search = new URLSearchParams(
      Object.entries(params)
        .flatMap(([name, value]): [string, string][] => (value === undefined ? [] : [[name, String(value)]]))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return cache.getOrLoad(`${baseUrl}${path}?${search}`, ttlMs, () => client.get(path, schema, { query: params }));
  };

  const list = async (type: MediaType, path: string, query: Query = {}) =>
    toPaged(await get(path, mediaPage, query, LIST_TTL_MS), type);

  const discover = (type: MediaType, page: number, filters: Query) =>
    list(type, `/discover/${type}`, { sort_by: 'popularity.desc', page, ...filters });

  return {
    trending: async (type: MediaType, window: 'day' | 'week'): Promise<MediaSummary[]> =>
      (await list(type, `/trending/${type}/${window}`)).results,

    /** Films et séries mélangés, dans l'ordre de TMDB (les personnes sont écartées). */
    trendingAll: async (window: 'day' | 'week'): Promise<MediaSummary[]> =>
      splitMixed((await get(`/trending/all/${window}`, rawPage(rawSearchItem), {}, LIST_TTL_MS)).results).results,

    popular: async (type: MediaType): Promise<MediaSummary[]> => (await list(type, `/${type}/popular`)).results,

    /** Films à venir en France. */
    upcoming: async (): Promise<MediaSummary[]> => (await list('movie', '/movie/upcoming', { region: REGION })).results,

    /** Séries actuellement diffusées. */
    onTheAir: async (): Promise<MediaSummary[]> => (await list('tv', '/tv/on_the_air')).results,

    /** Titres disponibles en streaming (abonnement) chez une plateforme, en France. */
    discoverByProvider: (type: MediaType, providerId: number, page = 1) =>
      discover(type, page, {
        with_watch_providers: providerId,
        watch_region: REGION,
        with_watch_monetization_types: 'flatrate',
      }),

    byGenre: (type: MediaType, genreId: number, page = 1) => discover(type, page, { with_genres: genreId }),

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
        { watch_region: REGION },
        DETAILS_TTL_MS,
      );
      const rank = (p: z.infer<typeof rawRegionProvider>) =>
        p.display_priorities?.[REGION] ?? p.display_priority ?? Number.MAX_SAFE_INTEGER;
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
      const query = { append_to_response: DETAILS_APPEND, include_video_language: 'fr,en,null' };
      const details = toDetails(await get(path, rawDetails, query, DETAILS_TTL_MS), type);
      if (details.title && details.overview) return details;
      try {
        const english = toSummary(await get(path, rawMedia, { language: FALLBACK_LANGUAGE }, DETAILS_TTL_MS), type);
        return { ...details, title: details.title || english.title, overview: details.overview || english.overview };
      } catch {
        return details; // repli au mieux : la fiche française reste valable
      }
    },

    /** Résumé d'un titre (affiche, année, synopsis), sans le reste de la fiche. */
    summary: async (type: MediaType, id: number): Promise<MediaSummary> =>
      toSummary(await get(`/${type}/${id}`, rawMedia, {}, DETAILS_TTL_MS), type),

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
