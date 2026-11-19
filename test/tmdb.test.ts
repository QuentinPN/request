import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmdb, imageUrl, testTmdb } from '../src/server/integrations/tmdb.ts';
import { TtlLru } from '../src/server/lib/lru.ts';
import { delay, type FakeHandler, startFakeServer, status } from './fake-server.ts';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/tmdb/${name}.json`, import.meta.url), 'utf8'));

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.signature';
const HOUR = 60 * 60 * 1000;

const closers: Array<() => Promise<void>> = [];
const serve = async (routes: Parameters<typeof startFakeServer>[0]) => {
  const server = await startFakeServer(routes);
  closers.push(server.close);
  return server;
};
const tmdbFor = (server: { url: string }, apiKey = V3_KEY) =>
  createTmdb({ apiKey, baseUrl: server.url }, new TtlLru({ maxEntries: 1000 }));

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('details', () => {
  it('normalise un film', async () => {
    const server = await serve({ 'GET /movie/603': fixture('movie') });
    const movie = await tmdbFor(server).details('movie', 603);

    expect(movie).toMatchObject({
      tmdbId: 603,
      type: 'movie',
      title: 'Matrix',
      year: 1999,
      posterPath: '/poster603.jpg',
      backdropPath: '/backdrop603.jpg',
      overview: 'Un hacker découvre la vérité sur son monde.',
      runtime: 136,
      seasons: [],
      genres: [
        { id: 28, name: 'Action' },
        { id: 878, name: 'Science-Fiction' },
      ],
      cast: [
        { id: 6384, name: 'Keanu Reeves', character: 'Neo', profilePath: '/keanu.jpg' },
        { id: 2975, name: 'Laurence Fishburne', character: 'Morpheus', profilePath: null },
      ],
      trailerKey: 'frTrailer',
      watchProviders: {
        flatrate: [{ id: 8, name: 'Netflix', logoPath: '/netflix.jpg' }],
        rent: [{ id: 2, name: 'Apple TV', logoPath: null }],
        buy: [],
      },
      externalIds: { imdb: 'tt0133093', tvdb: null },
    });
    expect(movie.recommendations).toEqual([
      {
        tmdbId: 604,
        type: 'movie',
        title: 'Matrix Reloaded',
        year: 2003,
        posterPath: '/p604.jpg',
        backdropPath: null,
        overview: 'Suite.',
      },
    ]);
    expect(movie.similar).toEqual([
      {
        tmdbId: 605,
        type: 'movie',
        title: 'Dark City',
        year: null,
        posterPath: null,
        backdropPath: null,
        overview: '',
      },
    ]);

    const [request] = server.requests;
    expect(request?.query).toMatchObject({
      language: 'fr-FR',
      append_to_response: 'credits,videos,recommendations,similar,watch/providers,external_ids,keywords',
      include_video_language: 'fr,en,null',
    });
  });

  it('normalise une série (saisons, titre `name`, bande-annonce sans langue, ids externes)', async () => {
    const server = await serve({ 'GET /tv/1396': fixture('tv') });
    const show = await tmdbFor(server).details('tv', 1396);

    expect(show).toMatchObject({
      tmdbId: 1396,
      type: 'tv',
      title: 'Breaking Bad',
      year: 2008,
      backdropPath: null,
      runtime: null,
      seasons: [
        { seasonNumber: 0, episodeCount: 9, airDate: null },
        { seasonNumber: 1, episodeCount: 7, airDate: '2008-01-20' },
      ],
      trailerKey: 'bbTrailer',
      watchProviders: { flatrate: [], rent: [], buy: [] },
      externalIds: { imdb: null, tvdb: 81189 },
    });
    expect(show.similar).toMatchObject([{ tmdbId: 1399, type: 'tv', title: 'Better Call Saul', year: 2015 }]);
  });

  it('limite la distribution aux 15 premiers rôles', async () => {
    const cast = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Acteur ${i}`, character: `Rôle ${i}` }));
    const server = await serve({ 'GET /movie/1': { id: 1, title: 'T', overview: 'O', credits: { cast } } });
    const movie = await tmdbFor(server).details('movie', 1);
    expect(movie.cast).toHaveLength(15);
    expect(movie.cast[14]?.name).toBe('Acteur 14');
  });

  it('préfère la bande-annonce anglaise à défaut de française', async () => {
    const videos = {
      results: [
        { key: 'other', site: 'YouTube', type: 'Trailer', iso_639_1: 'de' },
        { key: 'en', site: 'YouTube', type: 'Trailer', iso_639_1: 'en' },
      ],
    };
    const server = await serve({ 'GET /movie/1': { id: 1, title: 'T', overview: 'O', videos } });
    expect((await tmdbFor(server).details('movie', 1)).trailerKey).toBe('en');
  });

  it('lit les mots-clés : `keywords.keywords` pour un film, `keywords.results` pour une série', async () => {
    const keyword = { id: 818, name: 'based on novel or book' };
    const server = await serve({
      'GET /movie/1': { id: 1, title: 'T', overview: 'O', keywords: { keywords: [keyword] } },
      'GET /tv/2': { id: 2, name: 'S', overview: 'O', keywords: { results: [keyword] } },
      'GET /movie/3': { id: 3, title: 'Sans', overview: 'O' },
    });
    const tmdb = tmdbFor(server);
    expect((await tmdb.details('movie', 1)).keywords).toEqual([keyword]);
    expect((await tmdb.details('tv', 2)).keywords).toEqual([keyword]);
    expect((await tmdb.details('movie', 3)).keywords).toEqual([]);
  });

  it('complète en anglais un titre ou synopsis vide en français (un seul appel de plus)', async () => {
    const handler: FakeHandler = (req, res) =>
      status(200, fixture(req.query.language === 'en-US' ? 'movie-en' : 'movie-blank-fr'))(req, res);
    const server = await serve({ 'GET /movie/700': handler });
    const movie = await tmdbFor(server).details('movie', 700);

    expect(movie).toMatchObject({ title: 'Untranslated Film', overview: 'An English synopsis.', year: 2020 });
    expect(server.requests.map((r) => r.query.language)).toEqual(['fr-FR', 'en-US']);
  });

  it('garde la fiche française si le repli anglais échoue', async () => {
    const handler: FakeHandler = (req, res) =>
      status(req.query.language === 'en-US' ? 500 : 200, fixture('movie-blank-fr'))(req, res);
    const server = await serve({ 'GET /movie/700': handler });
    const movie = await tmdbFor(server).details('movie', 700);
    expect(movie).toMatchObject({ tmdbId: 700, title: '', overview: '', year: 2020 });
  });

  it('une année 0 ou invalide donne null', async () => {
    const server = await serve({
      'GET /movie/1': { id: 1, title: 'T', overview: 'O', release_date: '0000-00-00' },
      'GET /movie/2': { id: 2, title: 'T', overview: 'O', release_date: 'abcd' },
    });
    const tmdb = tmdbFor(server);
    expect((await tmdb.details('movie', 1)).year).toBeNull();
    expect((await tmdb.details('movie', 2)).year).toBeNull();
  });

  it("n'appelle pas l'anglais quand le français est complet", async () => {
    const server = await serve({ 'GET /movie/603': fixture('movie') });
    await tmdbFor(server).details('movie', 603);
    expect(server.requests).toHaveLength(1);
  });

  it('tvdbIdFor renvoie l’identifiant TVDB, ou null', async () => {
    const server = await serve({
      'GET /tv/1396/external_ids': { id: 1396, tvdb_id: 81189 },
      'GET /tv/2/external_ids': { id: 2, tvdb_id: null },
    });
    const tmdb = tmdbFor(server);
    expect(await tmdb.tvdbIdFor(1396)).toBe(81189);
    expect(await tmdb.tvdbIdFor(2)).toBeNull();
  });
});

describe('listes', () => {
  it('trending et popular renvoient des MediaSummary', async () => {
    const server = await serve({
      'GET /trending/movie/week': fixture('trending-movie'),
      'GET /tv/popular': {
        page: 1,
        total_pages: 1,
        results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }],
      },
    });
    const tmdb = tmdbFor(server);
    expect(await tmdb.trending('movie', 'week')).toEqual([
      {
        tmdbId: 603,
        type: 'movie',
        title: 'Matrix',
        year: 1999,
        posterPath: '/p.jpg',
        backdropPath: '/b.jpg',
        overview: 'Film.',
      },
    ]);
    expect(await tmdb.popular('tv')).toMatchObject([{ tmdbId: 1396, type: 'tv', title: 'Breaking Bad', year: 2008 }]);
  });

  it('upcoming (France) et onTheAir', async () => {
    const empty = { page: 1, total_pages: 1, results: [] };
    const server = await serve({ 'GET /movie/upcoming': empty, 'GET /tv/on_the_air': empty });
    const tmdb = tmdbFor(server);
    expect(await tmdb.upcoming()).toEqual([]);
    expect(await tmdb.onTheAir()).toEqual([]);
    expect(server.requests[0]?.query).toMatchObject({ region: 'FR', language: 'fr-FR' });
  });

  it('discoverByProvider cible le streaming par abonnement en France, paginé', async () => {
    const server = await serve({ 'GET /discover/tv': fixture('trending-movie') });
    const page = await tmdbFor(server).discoverByProvider('tv', 8, 2);
    expect(page).toMatchObject({ page: 1, totalPages: 5 });
    expect(server.requests[0]?.query).toMatchObject({
      with_watch_providers: '8',
      watch_region: 'FR',
      with_watch_monetization_types: 'flatrate',
      page: '2',
    });
  });

  it('genres', async () => {
    const server = await serve({
      'GET /discover/movie': fixture('trending-movie'),
      'GET /genre/movie/list': { genres: [{ id: 28, name: 'Action' }] },
    });
    const tmdb = tmdbFor(server);
    await tmdb.browse('movie', { genres: [28] });
    expect(server.requests[0]?.query).toMatchObject({ with_genres: '28', page: '1' });
    expect(await tmdb.genres('movie')).toEqual([{ id: 28, name: 'Action' }]);
  });

  it('écarte les mots-clés bloqués des flux /discover (`without_keywords`, séparés par | = OU)', async () => {
    const server = await serve({
      'GET /discover/movie': fixture('trending-movie'),
      'GET /discover/tv': fixture('trending-movie'),
    });
    const tmdb = tmdbFor(server);
    await tmdb.browse('movie', { genres: [28] }, 1, [818, 9715]);
    await tmdb.discoverByProvider('tv', 8, 1, [818]);
    await tmdb.browse('movie', { genres: [35] }, 1, []);
    expect(server.requests.map((r) => r.query.without_keywords)).toEqual(['818|9715', '818', undefined]);
  });

  it('searchKeywords lit la première page de /search/keyword', async () => {
    const server = await serve({
      'GET /search/keyword': { page: 1, total_pages: 5, total_results: 84, results: [{ id: 262419, name: 'lost' }] },
    });
    expect(await tmdbFor(server).searchKeywords('lost')).toEqual([{ id: 262419, name: 'lost' }]);
    expect(server.requests[0]?.query).toMatchObject({ query: 'lost', page: '1' });
  });

  it('searchMulti sépare films, séries et personnes', async () => {
    const server = await serve({ 'GET /search/multi': fixture('search') });
    const found = await tmdbFor(server).searchMulti('matrix', 2);

    expect(found.page).toBe(1);
    expect(found.totalPages).toBe(3);
    expect(found.results).toMatchObject([
      { tmdbId: 603, type: 'movie', title: 'Matrix', year: 1999 },
      { tmdbId: 1396, type: 'tv', title: 'Breaking Bad', year: 2008 },
    ]);
    expect(found.people).toEqual([
      { id: 6384, name: 'Keanu Reeves', profilePath: '/keanu.jpg', knownFor: ['Matrix', 'John Wick', 'Une série'] },
    ]);
    expect(server.requests[0]?.query).toMatchObject({ query: 'matrix', page: '2', language: 'fr-FR' });
  });
});

describe('authentification', () => {
  it('un jeton v4 (eyJ…) passe en Bearer, sans api_key', async () => {
    const server = await serve({ 'GET /movie/popular': { page: 1, total_pages: 1, results: [] } });
    await tmdbFor(server, V4_TOKEN).popular('movie');
    const [request] = server.requests;
    expect(request?.headers.authorization).toBe(`Bearer ${V4_TOKEN}`);
    expect(request?.query.api_key).toBeUndefined();
  });

  it('une clé v3 passe en paramètre api_key, sans en-tête', async () => {
    const server = await serve({ 'GET /movie/popular': { page: 1, total_pages: 1, results: [] } });
    await tmdbFor(server).popular('movie');
    const [request] = server.requests;
    expect(request?.query.api_key).toBe(V3_KEY);
    expect(request?.headers.authorization).toBeUndefined();
  });

  it('testTmdb valide la clé via /configuration', async () => {
    const server = await serve({ 'GET /configuration': { images: { base_url: 'http://image.tmdb.org/t/p/' } } });
    expect(await testTmdb({ apiKey: V4_TOKEN, baseUrl: server.url })).toEqual({ ok: true });
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${V4_TOKEN}`);
  });

  it('un 401 donne un message lisible, sans la clé', async () => {
    const server = await serve({ 'GET /configuration': status(401, { status_code: 7 }) });
    await expect(testTmdb({ apiKey: V3_KEY, baseUrl: server.url })).rejects.toMatchObject({
      name: 'IntegrationError',
      kind: 'unauthorized',
      message: 'Clé TMDB refusée',
    });
  });

  it('un 401 sur une requête normale lève une erreur lisible', async () => {
    const server = await serve({ 'GET /movie/popular': status(401) });
    await expect(tmdbFor(server).popular('movie')).rejects.toMatchObject({
      name: 'IntegrationError',
      kind: 'unauthorized',
      message: 'Clé TMDB refusée',
    });
  });

  it("n'expose jamais la clé v3 dans les erreurs (message, adresse, sérialisation)", async () => {
    const server = await serve({ 'GET /movie/1': status(404), 'GET /movie/2': { not: 'a movie' } });
    const tmdb = tmdbFor(server);
    for (const id of [1, 2]) {
      const error = await tmdb.details('movie', id).then(
        () => undefined,
        (e: unknown) => e as Error & { url?: string },
      );
      expect(error).toBeDefined();
      expect(error?.url).toContain('api_key=');
      for (const text of [error?.message, error?.url, String(error), JSON.stringify(error)])
        expect(text).not.toContain(V3_KEY);
    }
  });

  it('testTmdb lève une erreur lisible quand TMDB est injoignable', async () => {
    const server = await startFakeServer();
    await server.close();
    await expect(testTmdb({ apiKey: V3_KEY, baseUrl: server.url })).rejects.toMatchObject({
      name: 'IntegrationError',
      message: 'TMDB injoignable',
    });
  });
});

describe('cache', () => {
  it('une même requête ne part qu’une fois', async () => {
    const server = await serve({ 'GET /movie/603': fixture('movie') });
    const tmdb = tmdbFor(server);
    const first = await tmdb.details('movie', 603);
    const second = await tmdb.details('movie', 603);
    expect(second).toEqual(first);
    expect(server.requests).toHaveLength(1);
  });

  it('des requêtes différentes (page, type) ne se confondent pas', async () => {
    const server = await serve({ 'GET /discover/movie': fixture('trending-movie') });
    const tmdb = tmdbFor(server);
    await tmdb.browse('movie', { genres: [28] }, 1);
    await tmdb.browse('movie', { genres: [28] }, 2);
    await tmdb.browse('movie', { genres: [35] }, 1);
    expect(server.requests).toHaveLength(3);
  });

  it('deux appels simultanés partagent une seule requête', async () => {
    const server = await serve({ 'GET /trending/movie/day': delay(50, fixture('trending-movie')) });
    const tmdb = tmdbFor(server);
    const [a, b] = await Promise.all([tmdb.trending('movie', 'day'), tmdb.trending('movie', 'day')]);
    expect(a).toEqual(b);
    expect(server.requests).toHaveLength(1);
  });

  it('un échec n’est pas mémorisé', async () => {
    const server = await serve({ 'GET /movie/popular': status(401) });
    const tmdb = tmdbFor(server);
    await expect(tmdb.popular('movie')).rejects.toThrow();
    await expect(tmdb.popular('movie')).rejects.toThrow();
    expect(server.requests).toHaveLength(2);
  });

  it('listes gardées ~1 h, fiches ~6 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = await serve({
      'GET /trending/movie/week': fixture('trending-movie'),
      'GET /movie/603': fixture('movie'),
    });
    const tmdb = tmdbFor(server);
    await tmdb.trending('movie', 'week');
    await tmdb.details('movie', 603);

    vi.advanceTimersByTime(HOUR - 1000);
    await tmdb.trending('movie', 'week');
    expect(server.requests).toHaveLength(2);

    vi.advanceTimersByTime(2000);
    await tmdb.trending('movie', 'week');
    await tmdb.details('movie', 603);
    expect(server.requests.map((r) => r.path)).toEqual(['/trending/movie/week', '/movie/603', '/trending/movie/week']);

    vi.advanceTimersByTime(6 * HOUR);
    await tmdb.details('movie', 603);
    expect(server.requests).toHaveLength(4);
  });
});

describe('imageUrl', () => {
  it('construit les adresses par type', () => {
    expect(imageUrl('/a.jpg', 'poster')).toBe('/api/images/w342/a.jpg');
    expect(imageUrl('/a.jpg', 'backdrop')).toBe('/api/images/w1280/a.jpg');
    expect(imageUrl('/a.jpg', 'profile')).toBe('/api/images/w185/a.jpg');
  });

  it("renvoie null sans chemin d'image", () => {
    expect(imageUrl(null, 'poster')).toBeNull();
    expect(imageUrl('', 'poster')).toBeNull();
  });
});
