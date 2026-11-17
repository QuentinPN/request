import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import {
  discoverResponseSchema,
  genresResponseSchema,
  pagedMediaSchema,
  providersResponseSchema,
} from '../../shared/catalogue.ts';
import {
  type MediaDetails,
  type MediaSummary,
  type MediaType,
  mediaDetailsSchema,
  mediaSearchResultsSchema,
  type Season,
} from '../../shared/media.ts';
import { apiGet } from './http.ts';

// Seules définitions des requêtes du catalogue (clés et adresses), lues par toutes les pages.

export const discoverQuery = () =>
  queryOptions({
    queryKey: ['discover'],
    queryFn: ({ signal }) => apiGet('/api/discover', discoverResponseSchema, signal),
  });

export const genresQuery = (type: MediaType) =>
  queryOptions({
    queryKey: ['genres', type],
    queryFn: ({ signal }) => apiGet(`/api/genres/${type}`, genresResponseSchema, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const providersQuery = (type: MediaType) =>
  queryOptions({
    queryKey: ['providers', type],
    queryFn: ({ signal }) => apiGet(`/api/providers/${type}`, providersResponseSchema, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const mediaQuery = (type: MediaType, id: number) =>
  queryOptions({
    queryKey: ['media', type, id],
    queryFn: ({ signal }) => apiGet(`/api/media/${type}/${id}`, mediaDetailsSchema, signal),
  });

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ['search', q],
    queryFn: ({ signal }) => apiGet(`/api/search?${new URLSearchParams({ q })}`, mediaSearchResultsSchema, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });

/** Liste paginée « Charger plus » : par genre ou par plateforme. */
export const discoverListQuery = (by: 'genre' | 'provider', type: MediaType, id: number) =>
  infiniteQueryOptions({
    queryKey: ['discover', by, type, id],
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/api/discover/${type}/${by}/${id}?page=${pageParam}`, pagedMediaSchema, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

/** `?genre=` des pages Films et Séries (absent ou invalide : premier genre). */
export const genreSearchSchema = z.object({ genre: z.coerce.number().int().positive().optional().catch(undefined) });

// --- Libellés ---

export const mediaKey = (media: Pick<MediaSummary, 'type' | 'tmdbId'>) => `${media.type}:${media.tmdbId}`;

/** Supprime les doublons entre pages (TMDB en renvoie quand la popularité bouge pendant le défilement). */
export function uniqueMedia(items: MediaSummary[]): MediaSummary[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(mediaKey(item)) && seen.add(mediaKey(item)));
}

export const mediaTypeLabel: Record<MediaType, string> = { movie: 'Film', tv: 'Série' };
export const mediaTypePlural: Record<MediaType, string> = { movie: 'Films', tv: 'Séries' };
/** « Aucun film » / « Aucune série » : le genre du nom compte. */
export const mediaTypeNone: Record<MediaType, string> = { movie: 'Aucun film', tv: 'Aucune série' };

/** « 1 épisode », « 3 épisodes ». */
export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** 166 → « 2 h 46 », 45 → « 45 min ». */
export function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** Les épisodes spéciaux (saison 0) ne comptent pas comme une saison. */
export const regularSeasons = (seasons: Season[]) => seasons.filter((s) => s.seasonNumber > 0);

export const seasonTitle = (season: Season) =>
  season.seasonNumber === 0 ? 'Épisodes spéciaux' : `Saison ${season.seasonNumber}`;

export function seasonMeta(season: Season): string {
  const year = season.airDate?.slice(0, 4);
  return [plural(season.episodeCount, 'épisode', 'épisodes'), year].filter(Boolean).join(' · ');
}

/** « 8/10 épisodes » : épisodes présents sur ceux déjà diffusés. */
export const episodesLabel = ({ present, expected }: NonNullable<Season['episodes']>) =>
  `${present}/${expected} ${expected > 1 ? 'épisodes' : 'épisode'}`;

const present = (parts: (string | number | null | false | undefined)[]) =>
  parts.filter((part) => part !== null && part !== false && part !== undefined && part !== '').map(String);

/** Année et type (« 2024 », « Film ») : sous une affiche, dans le hero, dans la recherche. */
export const summaryMeta = (media: Pick<MediaSummary, 'year' | 'type'>) =>
  present([media.year, mediaTypeLabel[media.type]]);

/** Ligne de métadonnées d'une fiche : année, type et durée (film) ou nombre de saisons (série). */
export function detailsMeta(media: MediaDetails): string[] {
  const seasons = regularSeasons(media.seasons).length;
  const length =
    media.type === 'movie'
      ? media.runtime && formatRuntime(media.runtime)
      : seasons > 0 && plural(seasons, 'saison', 'saisons');
  return [...summaryMeta(media), ...present([length])];
}
