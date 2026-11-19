import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { closedPortUrl, type FakeRoutes, startFakeServer, status } from './fake-server.ts';
import { loginAsOwner, trackTempDirs } from './helpers.ts';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/tmdb/${name}.json`, import.meta.url), 'utf8'));

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Appli branchée sur un faux TMDB (`routes`) ; `tmdb: false` laisse TMDB non configuré. */
async function setup(routes: FakeRoutes = {}, { tmdb = true, tmdbUrl }: { tmdb?: boolean; tmdbUrl?: string } = {}) {
  const server = await startFakeServer(routes);
  const data = openDataDir(tempDir());
  if (tmdb) setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdbUrl ?? server.url } });
  cleanups.push(() => app.close(), server.close);
  const { headers } = await loginAsOwner(app);
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  return { app, data, server, get };
}

const page = (results: unknown[], totalPages = 1) => ({ page: 1, total_pages: totalPages, results });
const movie = { id: 603, title: 'Matrix', release_date: '1999-03-30', poster_path: '/p.jpg' };
const show = { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' };

const discoverRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /trending/all/week': page([
    { ...movie, media_type: 'movie' },
    { id: 6384, media_type: 'person', name: 'Keanu' },
  ]),
  'GET /movie/popular': page([movie]),
  'GET /tv/popular': page([show]),
  'GET /movie/upcoming': page([{ id: 7, title: 'Bientôt', release_date: '2027-01-01' }]),
  ...overrides,
});

describe('GET /api/discover', () => {
  it('exige une session (garde global de /api)', async () => {
    const { app, server } = await setup(discoverRoutes());
    const res = await app.inject({ method: 'GET', url: '/api/discover' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Connexion requise' });
    expect(server.requests).toHaveLength(0);
  });

  it('renvoie les rangées dans l’ordre du produit, en films et séries', async () => {
    const { get } = await setup(discoverRoutes());
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    const { rows } = res.json();
    expect(rows.map((r: { id: string; title: string }) => [r.id, r.title])).toEqual([
      ['trending', 'Tendances'],
      ['popular-movies', 'Films populaires'],
      ['popular-tv', 'Séries populaires'],
      ['upcoming', 'Prochainement'],
    ]);
    // les personnes de « Tendances » sont écartées
    expect(rows[0].items).toMatchObject([{ tmdbId: 603, type: 'movie', title: 'Matrix', year: 1999 }]);
    expect(rows[2].items).toMatchObject([{ tmdbId: 1396, type: 'tv', title: 'Breaking Bad' }]);
  });

  it('omet une rangée en échec sans casser la page', async () => {
    const { get } = await setup(discoverRoutes({ 'GET /tv/popular': status(401, {}) }));
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { id: string }) => r.id)).toEqual(['trending', 'popular-movies', 'upcoming']);
  });

  it('renvoie 502 quand toutes les rangées échouent', async () => {
    const { get } = await setup({}, { tmdbUrl: await closedPortUrl() });
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'TMDB injoignable' });
  });
});

describe('découverte par genre et par plateforme', () => {
  it('GET /api/discover/:type pagine avec les filtres', async () => {
    const { get, server } = await setup({ 'GET /discover/movie': fixture('trending-movie') });
    const res = await get('/api/discover/movie?genres=28&page=2');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, totalPages: 5, results: [{ tmdbId: 603, type: 'movie' }] });
    expect(server.requests[0]?.query).toMatchObject({ with_genres: '28', page: '2' });
  });

  it('GET /api/discover/:type/provider/:id cible le streaming en France', async () => {
    const { get, server } = await setup({ 'GET /discover/tv': fixture('trending-movie') });
    const res = await get('/api/discover/tv/provider/8');

    expect(res.statusCode).toBe(200);
    expect(server.requests[0]?.query).toMatchObject({
      with_watch_providers: '8',
      watch_region: 'FR',
      with_watch_monetization_types: 'flatrate',
      page: '1',
    });
  });

  it('GET /api/genres/:type', async () => {
    const { get } = await setup({ 'GET /genre/tv/list': { genres: [{ id: 18, name: 'Drame' }] } });
    const res = await get('/api/genres/tv');

    expect(res.json()).toEqual({ genres: [{ id: 18, name: 'Drame' }] });
  });

  it('GET /api/providers/:type liste les plateformes de France, les plus en vue d’abord', async () => {
    const { get, server } = await setup({
      'GET /watch/providers/movie': {
        results: [
          { provider_id: 2, provider_name: 'Apple TV', logo_path: '/a.jpg', display_priorities: { FR: 9 } },
          { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priorities: { FR: 1 } },
          { provider_id: 3, provider_name: 'Sans rang', logo_path: null },
        ],
      },
    });
    const res = await get('/api/providers/movie');

    expect(res.json()).toEqual({
      providers: [
        { id: 8, name: 'Netflix', logoPath: '/n.jpg' },
        { id: 2, name: 'Apple TV', logoPath: '/a.jpg' },
        { id: 3, name: 'Sans rang', logoPath: null },
      ],
    });
    expect(server.requests[0]?.query).toMatchObject({ watch_region: 'FR' });
  });
});

describe('GET /api/search', () => {
  it('renvoie films, séries et personnes ; `q` est rogné', async () => {
    const { get, server } = await setup({ 'GET /search/multi': fixture('search') });
    const res = await get('/api/search?q=%20matrix%20&page=2');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 1, totalPages: 3 });
    expect(body.results).toHaveLength(2);
    expect(body.people).toMatchObject([{ id: 6384, name: 'Keanu Reeves' }]);
    expect(server.requests[0]?.query).toMatchObject({ query: 'matrix', page: '2' });
  });
});

describe('GET /api/media/:type/:id', () => {
  it('renvoie la fiche d’un film et d’une série', async () => {
    const { get } = await setup({ 'GET /movie/603': fixture('movie'), 'GET /tv/1396': fixture('tv') });

    const film = await get('/api/media/movie/603');
    expect(film.statusCode).toBe(200);
    expect(film.json()).toMatchObject({ tmdbId: 603, type: 'movie', title: 'Matrix', runtime: 136 });
    expect(film.json().watchProviders.flatrate).toEqual([{ id: 8, name: 'Netflix', logoPath: '/netflix.jpg' }]);

    const serie = await get('/api/media/tv/1396');
    expect(serie.statusCode).toBe(200);
    expect(serie.json()).toMatchObject({ tmdbId: 1396, type: 'tv' });
  });

  it('renvoie 404 « Titre introuvable » quand TMDB ne connaît pas le titre', async () => {
    const { get } = await setup({ 'GET /movie/999': status(404, { status_code: 34 }) });
    const res = await get('/api/media/movie/999');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Titre introuvable' });
  });
});

describe('filtres de Films et Séries (GET /api/discover/:type)', () => {
  it('sans filtre : popularité, page 1, aucun autre paramètre de filtre', async () => {
    const { get, server } = await setup({ 'GET /discover/movie': fixture('trending-movie') });
    const res = await get('/api/discover/movie');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, totalPages: 5, results: [{ tmdbId: 603, type: 'movie' }] });
    const { query } = server.requests[0] ?? { query: {} };
    expect(query).toMatchObject({ sort_by: 'popularity.desc', page: '1' });
    expect(Object.keys(query).filter((k) => /^(with_|vote_|primary_|first_)/.test(k))).toEqual([]);
  });

  it('films : tous les filtres traduits en paramètres TMDB', async () => {
    const { get, server } = await setup({ 'GET /discover/movie': fixture('trending-movie') });
    const params = new URLSearchParams({
      genres: '28,12',
      yearFrom: '2010',
      yearTo: '2020',
      rating: '7',
      runtimeMin: '90',
      runtimeMax: '150',
      language: 'ja',
      provider: '8',
      company: '420',
      network: '213',
      sort: 'release',
      page: '3',
    });
    expect((await get(`/api/discover/movie?${params}`)).statusCode).toBe(200);

    expect(server.requests[0]?.query).toEqual({
      language: 'fr-FR',
      page: '3',
      sort_by: 'primary_release_date.desc',
      with_genres: '28,12',
      'primary_release_date.gte': '2010-01-01',
      'primary_release_date.lte': '2020-12-31',
      'vote_average.gte': '7',
      'vote_count.gte': '200',
      'with_runtime.gte': '90',
      'with_runtime.lte': '150',
      with_original_language: 'ja',
      with_watch_providers: '8',
      watch_region: 'FR',
      with_watch_monetization_types: 'flatrate',
      with_companies: '420',
      api_key: V3_KEY,
    });
  });

  it('séries : dates de première diffusion, chaîne ; ni durée ni studio', async () => {
    const { get, server } = await setup({ 'GET /discover/tv': fixture('trending-movie') });
    const params = new URLSearchParams({
      yearFrom: '2015',
      runtimeMin: '90',
      company: '420',
      network: '213',
      sort: 'title',
    });
    expect((await get(`/api/discover/tv?${params}`)).statusCode).toBe(200);

    expect(server.requests[0]?.query).toEqual({
      language: 'fr-FR',
      page: '1',
      sort_by: 'name.asc',
      'first_air_date.gte': '2015-01-01',
      with_networks: '213',
      api_key: V3_KEY,
    });
  });

  it('trier par note exige un plancher de votes, même sans note minimale', async () => {
    const { get, server } = await setup({ 'GET /discover/movie': fixture('trending-movie') });
    await get('/api/discover/movie?sort=rating');

    expect(server.requests[0]?.query).toMatchObject({ sort_by: 'vote_average.desc', 'vote_count.gte': '200' });
    expect(server.requests[0]?.query).not.toHaveProperty('vote_average.gte');
  });

  it('un seul genre dans l’adresse reste un genre', async () => {
    const { get, server } = await setup({ 'GET /discover/movie': fixture('trending-movie') });
    await get('/api/discover/movie?genres=28');

    expect(server.requests[0]?.query).toMatchObject({ with_genres: '28' });
  });

  it.each([
    'genres=abc',
    'genres=28,,12',
    'genres=1,2,3,4,5,6,7,8,9,10,11',
    'yearFrom=1800',
    'yearTo=abc',
    'yearFrom=2020&yearTo=2010',
    'rating=0',
    'rating=11',
    'rating=7.5',
    'runtimeMin=0',
    'runtimeMin=150&runtimeMax=90',
    'language=fra',
    'language=FR',
    'provider=0',
    'company=-1',
    'network=x',
    'sort=popularity.desc',
    'page=0',
  ])('?%s → 400 sans appeler TMDB', async (query) => {
    const { get, server } = await setup();
    const res = await get(`/api/discover/movie?${query}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Requête invalide' });
    expect(server.requests).toHaveLength(0);
  });

  it('un type inconnu → 400', async () => {
    const { get } = await setup();
    expect((await get('/api/discover/anime?sort=title')).statusCode).toBe(400);
  });
});

describe('validation', () => {
  it.each([
    '/api/media/person/603',
    '/api/media/movie/0',
    '/api/media/movie/-3',
    '/api/media/movie/abc',
    '/api/media/movie/1.5',
    '/api/discover/anime?genres=28',
    '/api/discover/movie?genres=x',
    '/api/discover/movie/provider/0',
    '/api/discover/movie?genres=28&page=0',
    '/api/discover/movie?genres=28&page=501',
    '/api/discover/movie?genres=28&page=abc',
    '/api/genres/anime',
    '/api/providers/anime',
    '/api/search',
    '/api/search?q=',
    '/api/search?q=%20%20',
    `/api/search?q=${'a'.repeat(101)}`,
    '/api/search?q=matrix&page=0',
  ])('%s → 400', async (url) => {
    const { get, server } = await setup();
    const res = await get(url);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Requête invalide' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('contrat serveur', () => {
  it('une réponse de TMDB hors contrat est une erreur amont (502), pas une faute du client (400)', async () => {
    const { get } = await setup({ 'GET /movie/603': { ...fixture('movie'), runtime: 136.5 } });
    const res = await get('/api/media/movie/603');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Réponse inattendue de TMDB' });
  });

  it('omet de Découvrir une rangée hors contrat, les autres restent servies', async () => {
    const { get } = await setup(discoverRoutes({ 'GET /movie/popular': page([{ ...movie, id: 'x' }]) }));
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { id: string }) => r.id)).toEqual(['trending', 'popular-tv', 'upcoming']);
  });
});

describe('erreurs de TMDB', () => {
  const urls = [
    '/api/discover',
    '/api/discover/movie?genres=28',
    '/api/discover/tv/provider/8',
    '/api/genres/movie',
    '/api/providers/tv',
    '/api/search?q=matrix',
    '/api/media/movie/603',
    '/api/person/6384',
    '/api/collection/2344',
  ];

  it.each(urls)('%s → 503 tant que TMDB n’est pas configuré', async (url) => {
    const { get, server } = await setup({}, { tmdb: false });
    const res = await get(url);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "TMDB n'est pas encore configuré" });
    expect(server.requests).toHaveLength(0);
  });

  it('clé refusée → 502 avec le message lisible', async () => {
    const { get } = await setup({ 'GET /genre/movie/list': status(401, { status_code: 7 }) });
    const res = await get('/api/genres/movie');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Clé TMDB refusée' });
  });

  it('TMDB injoignable → 502', async () => {
    const { get } = await setup({}, { tmdbUrl: await closedPortUrl() });
    const res = await get('/api/search?q=matrix');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'TMDB injoignable' });
  });

  it('ne laisse jamais fuir la clé dans une erreur', async () => {
    const { get } = await setup({ 'GET /genre/movie/list': status(401) });
    expect((await get('/api/genres/movie')).body).not.toContain(V3_KEY);
  });
});

describe('client TMDB mémorisé par réglage', () => {
  it('utilise la nouvelle clé dès que le réglage change, sans redémarrage', async () => {
    const { get, data, server } = await setup({
      'GET /genre/movie/list': { genres: [] },
      'GET /genre/tv/list': { genres: [] },
    });
    await get('/api/genres/movie');
    setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: 'nouvelle-cle-0123456789' });
    await get('/api/genres/tv');

    expect(server.requests.map((r) => r.query.api_key)).toEqual([V3_KEY, 'nouvelle-cle-0123456789']);
  });
});
