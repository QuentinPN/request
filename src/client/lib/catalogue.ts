import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import {
  type BrowseFilters,
  browseFilterShape,
  browsePath,
  collectionPath,
  DEFAULT_BROWSE_SORT,
  DISCOVER_PATH,
  discoverListPath,
  discoverResponseSchema,
  genresPath,
  genresResponseSchema,
  invertedRanges,
  mediaPath,
  pagedMediaSchema,
  personPath,
  providersPath,
  providersResponseSchema,
  SEARCH_PATH,
} from '../../shared/catalogue.ts';
import {
  type CreditRole,
  type CrewJob,
  collectionDetailsSchema,
  type MediaDetails,
  type MediaKey,
  type MediaSummary,
  type MediaType,
  mediaDetailsSchema,
  mediaSearchResultsSchema,
  type PersonDetails,
  personDetailsSchema,
  type Season,
} from '../../shared/media.ts';
import { plural } from '../../shared/text.ts';
import { apiGet, nextPageParam } from './http.ts';

// Seules définitions des requêtes du catalogue (clés et adresses), lues par toutes les pages.

export const discoverQuery = () =>
  queryOptions({
    queryKey: ['discover'],
    queryFn: ({ signal }) => apiGet(DISCOVER_PATH, discoverResponseSchema, signal),
  });

export const genresQuery = (type: MediaType) =>
  queryOptions({
    queryKey: ['genres', type],
    queryFn: ({ signal }) => apiGet(genresPath(type), genresResponseSchema, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const providersQuery = (type: MediaType) =>
  queryOptions({
    queryKey: ['providers', type],
    queryFn: ({ signal }) => apiGet(providersPath(type), providersResponseSchema, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const mediaQuery = (type: MediaType, id: number) =>
  queryOptions({
    queryKey: ['media', type, id],
    queryFn: ({ signal }) => apiGet(mediaPath(type, id), mediaDetailsSchema, signal),
  });

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ['search', q],
    queryFn: ({ signal }) => apiGet(`${SEARCH_PATH}?${new URLSearchParams({ q })}`, mediaSearchResultsSchema, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });

/** Liste paginée « Charger plus » d'une plateforme. */
export const discoverListQuery = (type: MediaType, id: number) =>
  infiniteQueryOptions({
    queryKey: ['discover', 'provider', type, id],
    queryFn: ({ pageParam, signal }) =>
      apiGet(`${discoverListPath(type, id)}?page=${pageParam}`, pagedMediaSchema, signal),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
  });

export const personQuery = (id: number) =>
  queryOptions({
    queryKey: ['person', id],
    queryFn: ({ signal }) => apiGet(personPath(id), personDetailsSchema, signal),
  });

export const collectionQuery = (id: number) =>
  queryOptions({
    queryKey: ['collection', id],
    queryFn: ({ signal }) => apiGet(collectionPath(id), collectionDetailsSchema, signal),
  });

/** Page d'une personne : `<Link {...personLink(person)}>`. */
export const personLink = ({ id }: { id: number }) => ({ to: '/personne/$id' as const, params: { id: String(id) } });

/** Page d'une saga : `<Link {...collectionLink(collection)}>`. */
export const collectionLink = ({ id }: { id: number }) => ({
  to: '/collection/$id' as const,
  params: { id: String(id) },
});

/** Fiche d'un titre : `<Link {...titleLink(media)}>` ou `navigate(titleLink(media))`. */
export const titleLink = ({ type, tmdbId }: MediaKey) => ({
  to: '/titre/$type/$id' as const,
  params: { type, id: String(tmdbId) },
});

// --- Filtres de Films et Séries (adresse de la page) ---

/** Valeurs de l'adresse : un nombre ou un texte (`?genres=28,12&rating=7`), jamais un tableau. */
export type BrowseSearch = { [K in keyof BrowseFilters]?: string | number };

const withoutUndefined = <T extends object>(object: T): T =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;

/** Filtres lus dans l'adresse : un champ invalide est abandonné (adresse modifiée à la main), jamais une erreur. */
export function parseBrowseFilters(raw: Record<string, unknown>): BrowseFilters {
  const valid: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(browseFilterShape)) {
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) valid[key] = parsed.data;
  }
  for (const key of invertedRanges(valid)) delete valid[key];
  return valid as BrowseFilters;
}

/** Filtres écrits dans l'adresse, forme canonique : rien pour une valeur absente ou le tri par défaut ; un genre = un nombre. */
export function browseSearchOf({ genres, sort, ...rest }: BrowseFilters): BrowseSearch {
  return withoutUndefined({
    ...rest,
    genres: genres && genres.length > 0 ? (genres.length === 1 ? genres[0] : genres.join(',')) : undefined,
    sort: sort === DEFAULT_BROWSE_SORT ? undefined : sort,
  });
}

/** `validateSearch` de Films et Séries (adresse partageable). */
export const browseSearch = (raw: Record<string, unknown>): BrowseSearch => browseSearchOf(parseBrowseFilters(raw));

/** Liste paginée « Charger plus » des films ou séries filtrés. */
export const browseQuery = (type: MediaType, filters: BrowseFilters) => {
  const search = browseSearchOf(filters);
  return infiniteQueryOptions({
    queryKey: ['discover', 'browse', type, search],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        ...Object.fromEntries(Object.entries(search).map(([k, v]) => [k, String(v)])),
        page: String(pageParam),
      });
      return apiGet(`${browsePath(type)}?${params}`, pagedMediaSchema, signal);
    },
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
  });
};

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

// --- Personnes ---

/** Services de TMDB (en anglais) → français ; un service inconnu s'affiche tel quel. */
const departmentLabels: Record<string, string> = {
  Acting: 'Interprétation',
  Directing: 'Réalisation',
  Writing: 'Scénario',
  Production: 'Production',
  Creator: 'Création',
  Sound: 'Musique et son',
  Camera: 'Image',
  Editing: 'Montage',
  Art: 'Direction artistique',
  'Visual Effects': 'Effets visuels',
};

export const crewJobLabel: Record<CrewJob, string> = {
  director: 'Réalisation',
  writer: 'Scénario',
  creator: 'Création',
};

export const creditRoleLabel: Record<CreditRole, string> = { actor: 'Acteur', crew: 'Équipe' };

const longDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** « 2 septembre 1964 » depuis `1964-09-02` (jour TMDB, sans fuseau). */
const formatLongDate = (day: string) => longDate.format(new Date(`${day}T00:00:00Z`));

/** Âge au jour `until` (`YYYY-MM-DD`, aujourd'hui par défaut) d'une personne née le `birthday`. */
export function ageOn(birthday: string, until = new Date().toISOString().slice(0, 10)): number {
  const [by = 0, bm = 0, bd = 0] = birthday.split('-').map(Number);
  const [uy = 0, um = 0, ud = 0] = until.split('-').map(Number);
  return uy - by - (um < bm || (um === bm && ud < bd) ? 1 : 0);
}

/** Lignes « libellé : valeur » de l'en-tête d'une page personne (celles que TMDB ne renseigne pas sont omises). */
export function personFacts(person: PersonDetails): Array<{ label: string; value: string }> {
  const { birthday, deathday, placeOfBirth, knownForDepartment } = person;
  const age = birthday && plural(ageOn(birthday, deathday ?? undefined), 'an', 'ans');
  return [
    knownForDepartment && { label: 'Connu pour', value: departmentLabels[knownForDepartment] ?? knownForDepartment },
    birthday && { label: 'Naissance', value: `${formatLongDate(birthday)}${deathday ? '' : ` (${age})`}` },
    deathday && { label: 'Décès', value: `${formatLongDate(deathday)}${age ? ` (${age})` : ''}` },
    placeOfBirth && { label: 'Lieu de naissance', value: placeOfBirth },
  ].filter((fact) => !!fact);
}

/** Ligne de métadonnées d'une fiche : année, type et durée (film) ou nombre de saisons (série). */
export function detailsMeta(media: MediaDetails): string[] {
  const seasons = regularSeasons(media.seasons).length;
  const length =
    media.type === 'movie'
      ? media.runtime && formatRuntime(media.runtime)
      : seasons > 0 && plural(seasons, 'saison', 'saisons');
  return [...summaryMeta(media), ...present([length])];
}
