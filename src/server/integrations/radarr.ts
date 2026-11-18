import { z } from 'zod';
import type { MinimumAvailability } from '../../shared/settings.ts';
import {
  type ArrConfig,
  type ArrTestResult,
  arrClient,
  createOrRecover,
  firstOf,
  notFound,
  oneOrMany,
  parseArrWebhook,
  testArr,
} from './arr.ts';

const movieSchema = z.looseObject({
  id: z.number().catch(0),
  hasFile: z.boolean().catch(false),
  monitored: z.boolean().catch(false),
});
type Movie = z.infer<typeof movieSchema>;

export interface MovieStatus {
  radarrId: number;
  hasFile: boolean;
  monitored: boolean;
}
const toStatus = (movie: Movie): MovieStatus => ({
  radarrId: movie.id,
  hasFile: movie.hasFile,
  monitored: movie.monitored,
});

export interface AddMovieInput {
  tmdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  minimumAvailability?: MinimumAvailability;
  /** Lance la recherche dès l'ajout. */
  search: boolean;
}

export const testRadarr = (config: ArrConfig): Promise<ArrTestResult> => testArr('radarr', config);

/** Fiche Radarr d'un film d'après son id TMDB ; `id > 0` si le film est déjà dans la bibliothèque. */
export async function lookupMovie(config: ArrConfig, tmdbId: number) {
  const found = firstOf(
    await arrClient('radarr', config).get('/movie/lookup/tmdb', oneOrMany(movieSchema), { tmdbId }),
  );
  if (!found) throw notFound('radarr', 'Film');
  return found;
}

/** Film déjà présent dans Radarr, ou `null`. */
export async function getMovieByTmdbId(config: ArrConfig, tmdbId: number): Promise<MovieStatus | null> {
  const movies = await arrClient('radarr', config).get('/movie', z.array(movieSchema), { tmdbId });
  const movie = movies.find((m) => m.id > 0);
  return movie ? toStatus(movie) : null;
}

export interface LibraryMovie extends MovieStatus {
  tmdbId: number;
}
const libraryMovieSchema = movieSchema.extend({ tmdbId: z.number().catch(0) });

/** Tous les films de Radarr en un appel : les statuts d'une page d'affiches sans une requête par film. */
export async function listMovies(config: ArrConfig): Promise<LibraryMovie[]> {
  const movies = await arrClient('radarr', config).get('/movie', z.array(libraryMovieSchema));
  return movies.filter((m) => m.id > 0 && m.tmdbId > 0).map((m) => ({ ...toStatus(m), tmdbId: m.tmdbId }));
}

export async function getMovieStatus(config: ArrConfig, radarrId: number): Promise<MovieStatus> {
  return toStatus(await arrClient('radarr', config).get(`/movie/${radarrId}`, movieSchema));
}

/** Ajoute le film (avec recherche) ; s'il y est déjà, renvoie son id sans erreur. */
export async function addMovie(config: ArrConfig, input: AddMovieInput): Promise<{ radarrId: number }> {
  const lookup = await lookupMovie(config, input.tmdbId);
  if (lookup.id > 0) return { radarrId: lookup.id };

  const { id: _id, ...movie } = lookup;
  return createOrRecover(
    async () => {
      const created = await arrClient('radarr', config).post('/movie', movieSchema, {
        ...movie,
        tmdbId: input.tmdbId,
        qualityProfileId: input.qualityProfileId,
        rootFolderPath: input.rootFolderPath,
        monitored: true,
        ...(input.minimumAvailability && { minimumAvailability: input.minimumAvailability }),
        addOptions: { searchForMovie: input.search },
      });
      return { radarrId: created.id };
    },
    async () => {
      const existing = await getMovieByTmdbId(config, input.tmdbId);
      return existing ? { radarrId: existing.radarrId } : undefined;
    },
  );
}

export const parseRadarrWebhook = (body: unknown) => parseArrWebhook(body, 'movie');
