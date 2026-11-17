import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import type { z } from 'zod';
import {
  discoverResponseSchema,
  genresResponseSchema,
  pagedMediaSchema,
  providersResponseSchema,
} from '../src/shared/catalogue.ts';
import { mediaDetailsSchema, mediaSearchResultsSchema } from '../src/shared/media.ts';

// Fixtures JSON validées par les schémas partagés : un changement de contrat casse les tests, pas l'écran en silence.
const load = <T>(name: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));

export const fixtures = {
  discover: load('discover', discoverResponseSchema),
  genres: { movie: load('genres-movie', genresResponseSchema), tv: load('genres-tv', genresResponseSchema) },
  providers: load('providers-movie', providersResponseSchema),
  listing: load('listing', pagedMediaSchema),
  tv: load('media-tv', mediaDetailsSchema),
  movie: load('media-movie', mediaDetailsSchema),
  search: load('search', mediaSearchResultsSchema),
};

/** Recherche qui ne trouve rien. */
export const NO_RESULT_QUERY = 'zzzz';

// Visuels de remplacement : aplats teintés comme dans les maquettes, déterministes par nom de fichier.
const tints = ['#2d3e4f', '#5a4630', '#4b2f2f', '#2f4a52', '#3d3d45', '#33443a', '#5a5230', '#2b3550', '#4a3420'];
function placeholderImage(path: string) {
  const hash = [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tint = tints[hash % tints.length];
  const [w, h] = path.includes('/w1280/') ? [1280, 720] : path.includes('/w185/') ? [185, 278] : [342, 513];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tint}"/><stop offset="1" stop-color="#101216"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.35}" fill="#ffffff" fill-opacity="0.06"/></svg>`;
}

function nextPage(page: number) {
  const { listing } = fixtures;
  return {
    ...listing,
    page,
    results: listing.results.map((m) => ({ ...m, tmdbId: m.tmdbId + page * 100_000, title: `${m.title} ${page}` })),
  };
}

/** Réponse du catalogue, ou `null` si la route n'en fait pas partie. */
function respond(url: URL): { status: number; body: unknown } | null {
  const path = url.pathname;
  const notFound = { status: 404, body: { error: 'Introuvable' } };
  if (path === '/api/discover') return { status: 200, body: fixtures.discover };
  if (/^\/api\/discover\/(movie|tv)\/(genre|provider)\/\d+$/.test(path)) {
    const page = Number(url.searchParams.get('page') ?? 1);
    return { status: 200, body: page === 1 ? fixtures.listing : nextPage(page) };
  }
  const genres = path.match(/^\/api\/genres\/(movie|tv)$/);
  if (genres) return { status: 200, body: fixtures.genres[genres[1] as 'movie' | 'tv'] };
  if (/^\/api\/providers\/(movie|tv)$/.test(path)) return { status: 200, body: fixtures.providers };
  if (path === '/api/search') {
    const empty = url.searchParams.get('q') === NO_RESULT_QUERY;
    return { status: 200, body: empty ? { page: 1, totalPages: 0, results: [], people: [] } : fixtures.search };
  }
  const media = path.match(/^\/api\/media\/(movie|tv)\/(\d+)$/);
  if (media) {
    const found = [fixtures.tv, fixtures.movie].find((m) => m.type === media[1] && m.tmdbId === Number(media[2]));
    return found ? { status: 200, body: found } : notFound;
  }
  return null;
}

/**
 * Sert l'API du catalogue depuis les fixtures ; le reste (`/api/auth/me`, `/api/setup/state`…) passe au faux serveur
 * de `support/api.ts`. `failWith` renvoie un statut d'erreur à servir à la place (503, 500…) pour le catalogue,
 * relu à chaque requête : un test peut le changer en cours de route (« Réessayer »).
 */
export async function mockCatalogue(page: Page, { failWith }: { failWith?: () => number | null } = {}) {
  await page.route('https://www.youtube-nocookie.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Lecteur</title><body style="background:#000">',
    }),
  );
  await page.route('**/api/**', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/images/'))
      return route.fulfill({ contentType: 'image/svg+xml', body: placeholderImage(url.pathname) });
    const response = respond(url);
    if (!response) return route.fallback();
    const status = failWith?.();
    if (status) {
      const error = status === 503 ? 'TMDB n’est pas encore configuré' : 'Erreur interne du serveur';
      return route.fulfill({ status, json: { error } });
    }
    return route.fulfill({ status: response.status, json: response.body });
  });
}
