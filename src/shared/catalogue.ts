import { z } from 'zod';
import {
  genreSchema,
  imageSizeSchema,
  type MediaType,
  mediaSummarySchema,
  mediaTypeSchema,
  pagedSchema,
  watchProviderSchema,
} from './media.ts';
import { settingsPathOf } from './settings-path.ts';

// --- Paramètres de requête (validés côté serveur, réutilisables par le client) ---

const positiveInt = z.coerce.number().int().positive();

/** `?page=` : TMDB ne pagine pas au-delà de 500. */
export const pageQuerySchema = z.object({ page: positiveInt.max(500).default(1) });
export const searchQuerySchema = pageQuerySchema.extend({ q: z.string().trim().min(1).max(100) });

export const typeParamsSchema = z.object({ type: mediaTypeSchema });
export const typeIdParamsSchema = typeParamsSchema.extend({ id: positiveInt });
export const idParamsSchema = z.object({ id: positiveInt });

// --- Filtres de Films et Séries (adresse de la page et requête de l'API : mêmes noms, mêmes formats) ---

export const BROWSE_SORTS = ['popularity', 'rating', 'release', 'title'] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];
export const DEFAULT_BROWSE_SORT: BrowseSort = 'popularity';
const MAX_GENRES = 10;

/** `28,12` (ou `28` : le routeur lit un nombre seul comme un nombre) → [28, 12] ; plusieurs genres = tous à la fois. */
const idList = z
  .preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().regex(/^\d+(,\d+)*$/))
  .transform((value) => value.split(',').map(Number))
  .pipe(z.array(z.number().int().positive()).max(MAX_GENRES));

const yearField = z.coerce.number().int().min(1900).max(2100);
const minutesField = positiveInt.max(1000);

export const browseFilterShape = {
  genres: idList,
  yearFrom: yearField,
  yearTo: yearField,
  /** Note minimale (sur 10), appliquée avec un plancher de votes côté serveur. */
  rating: z.coerce.number().int().min(1).max(10),
  /** Durée en minutes (films seulement). */
  runtimeMin: minutesField,
  runtimeMax: minutesField,
  /** Langue originale, code ISO 639-1. */
  language: z.string().regex(/^[a-z]{2}$/),
  /** Plateforme de streaming (France, abonnement). */
  provider: positiveInt,
  sort: z.enum(BROWSE_SORTS),
  /** Studio (films) ou chaîne (séries) : `with_companies` / `with_networks`. */
  company: positiveInt,
  network: positiveInt,
} as const;

type Ranges = { yearFrom?: number; yearTo?: number; runtimeMin?: number; runtimeMax?: number };

/** Bornes dans le mauvais ordre (début après fin) : le champ de fin fautif, que la page abandonne et que l'API refuse. */
export const invertedRanges = (f: Ranges): Array<'yearTo' | 'runtimeMax'> => [
  ...(f.yearFrom !== undefined && f.yearTo !== undefined && f.yearFrom > f.yearTo ? (['yearTo'] as const) : []),
  ...(f.runtimeMin !== undefined && f.runtimeMax !== undefined && f.runtimeMin > f.runtimeMax
    ? (['runtimeMax'] as const)
    : []),
];

const rejectInvertedRanges = (ctx: z.core.ParsePayload<Ranges>) => {
  for (const path of invertedRanges(ctx.value))
    ctx.issues.push({
      code: 'custom',
      message: 'Bornes dans le mauvais ordre',
      path: [path],
      input: ctx.value[path],
    });
};

export const browseFiltersSchema = z.object(browseFilterShape).partial().check(rejectInvertedRanges);
export type BrowseFilters = z.infer<typeof browseFiltersSchema>;

/**
 * Filtres tels qu'enregistrés (rangée sur mesure de Découvrir) : mêmes champs et mêmes sorties que `browseFiltersSchema`,
 * mais les genres sont un tableau, relisible tel quel (l'adresse d'une page les écrit `28,12`).
 */
export const savedFiltersSchema = z
  .object({ ...browseFilterShape, genres: z.array(z.number().int().positive()).max(MAX_GENRES) })
  .partial()
  .check(rejectInvertedRanges);

/** Page de résultats filtrés (`GET /api/discover/:type`). */
export const browseQuerySchema = pageQuerySchema.and(browseFiltersSchema);

// --- Adresses de l'API ---

type TypeParam = MediaType | ':type';
type IdParam = number | ':id';
export const DISCOVER_PATH = '/api/discover';
/** Liste « Charger plus » d'une plateforme. */
export const discoverListPath = (type: TypeParam, id: IdParam) => `${DISCOVER_PATH}/${type}/provider/${id}`;
/** Films ou séries filtrés (`browseQuerySchema`), paginés. */
export const browsePath = (type: TypeParam) => `${DISCOVER_PATH}/${type}`;
export const genresPath = (type: TypeParam) => `/api/genres/${type}`;
export const providersPath = (type: TypeParam) => `/api/providers/${type}`;
export const SEARCH_PATH = '/api/search';
export const mediaPath = (type: TypeParam, id: IdParam) => `/api/media/${type}/${id}`;
export const personPath = (id: IdParam) => `/api/person/${id}`;
export const collectionPath = (id: IdParam) => `/api/collection/${id}`;

/** Réglage `discover` (masquer disponibles / déjà demandés), propriétaire seulement. */
export const DISCOVER_SETTINGS_PATH = settingsPathOf('discover');
/** Réglage `discoverLayout` (ordre, rangées masquées et rangées sur mesure de Découvrir), propriétaire seulement. */
export const DISCOVER_LAYOUT_PATH = settingsPathOf('discover-layout');

// --- Réponses ---

/** Rangée d'affiches ; `seeAll` : la rangée sur mesure renvoie à Films ou Séries avec les mêmes filtres (« Tout voir »). */
export const discoverRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  items: z.array(mediaSummarySchema),
  seeAll: z.object({ type: mediaTypeSchema, filters: savedFiltersSchema }).optional(),
});

/**
 * `rows` : les rangées d'affiches, dans l'ordre configuré ; `layout` : les identifiants de toutes les rangées actives
 * dans cet ordre, y compris les rangées à logos (plateformes, studios, chaînes) que le navigateur construit lui-même.
 */
export const discoverResponseSchema = z.object({ rows: z.array(discoverRowSchema), layout: z.array(z.string()) });
export type DiscoverResponse = z.infer<typeof discoverResponseSchema>;

export const pagedMediaSchema = pagedSchema(mediaSummarySchema);

export const genresResponseSchema = z.object({ genres: z.array(genreSchema) });

export const providersResponseSchema = z.object({ providers: z.array(watchProviderSchema) });

// --- Images ---

/** Nom de fichier TMDB (`abc123.jpg`) : ni séparateur ni `..`, donc aucun parcours de dossiers possible. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const imageFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|svg)$/)
  // Noms réservés de Windows (`con.jpg`…) : ils ne désignent pas un fichier ordinaire.
  .refine((file) => !WINDOWS_RESERVED.test(file.slice(0, file.lastIndexOf('.'))));
export const imageParamsSchema = z.object({ size: imageSizeSchema, file: imageFileSchema });
