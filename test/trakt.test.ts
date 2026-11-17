import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../src/server/integrations/http.ts';
import { fetchTraktWatchlist, testTrakt } from '../src/server/integrations/trakt.ts';
import { type FakeHandler, status } from './fake-server.ts';
import { trackFakeServers } from './helpers.ts';

const serve = trackFakeServers();

const CLIENT_ID = 'client-id-trakt-secret';
const movie = (tmdb: number | null, title: string, year = 2000) => ({
  rank: 1,
  type: 'movie',
  movie: { title, year, ids: { trakt: tmdb ?? 1, slug: title, tmdb } },
});
const show = (tmdb: number, title: string) => ({
  rank: 2,
  type: 'show',
  show: { title, year: 2019, ids: { trakt: 9, tvdb: 5, tmdb } },
});

/** Liste découpée en pages de `size` (Trakt ignore ici le `limit` demandé), page vide au-delà de la dernière. */
const paged =
  (items: unknown[], size: number): FakeHandler =>
  (req, res) => {
    const page = Number(req.query.page);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(items.slice((page - 1) * size, page * size)));
  };

describe('fetchTraktWatchlist', () => {
  it('lit toutes les pages, envoie la clé et la version, et garde films et séries', async () => {
    const trakt = await serve({
      'GET /users/alice/watchlist/movie,show/added': paged(
        [
          movie(603, 'Matrix', 1999),
          { type: 'season', season: { number: 1 }, show: { title: 'X', ids: {} } },
          show(1396, 'Breaking Bad'),
          movie(null, 'Sans identifiant'),
          movie(11, 'Star Wars', 1977),
        ],
        2,
      ),
    });

    const { titles, truncated } = await fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'alice');

    expect(truncated).toBe(false);
    expect(titles).toEqual([
      { type: 'movie', tmdbId: 603, title: 'Matrix', year: 1999 },
      { type: 'tv', tmdbId: 1396, title: 'Breaking Bad', year: 2019 },
      { type: 'movie', tmdbId: null, title: 'Sans identifiant', year: 2000 },
      { type: 'movie', tmdbId: 11, title: 'Star Wars', year: 1977 },
    ]);
    expect(trakt.requests.map((r) => r.query.page)).toEqual(['1', '2', '3', '4']);
    expect(trakt.requests[0]?.query.limit).toBe('100');
    expect(trakt.requests[0]?.headers).toMatchObject({ 'trakt-api-key': CLIENT_ID, 'trakt-api-version': '2' });
  });

  it('une liste vide donne une liste vide', async () => {
    const trakt = await serve({ 'GET /users/alice/watchlist/movie,show/added': [] });
    await expect(fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'alice')).resolves.toEqual({
      titles: [],
      truncated: false,
    });
    expect(trakt.requests).toHaveLength(1);
  });

  it('une liste sans fin est tronquée à 2 000 titres, et le signale', async () => {
    const trakt = await serve({
      'GET /users/alice/watchlist/movie,show/added': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.from({ length: 100 }, (_, i) => movie(i + 1, `Film ${i}`))));
      },
    });
    const { titles, truncated } = await fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'alice');
    expect(titles).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it('profil introuvable : erreur « not_found » au message lisible', async () => {
    const trakt = await serve({ 'GET /users/ghost/watchlist/movie,show/added': status(404) });
    await expect(fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'ghost')).rejects.toMatchObject({
      name: 'IntegrationError',
      kind: 'not_found',
      message: 'Profil Trakt introuvable ou privé',
    });
  });

  it('profil privé (401) : erreur « unauthorized », sans nouvelle tentative', async () => {
    const trakt = await serve({ 'GET /users/priv/watchlist/movie,show/added': status(401) });
    await expect(fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'priv')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(trakt.requests).toHaveLength(1);
  });

  it('une réponse hors contrat est une erreur de réponse, pas un plantage', async () => {
    const trakt = await serve({ 'GET /users/alice/watchlist/movie,show/added': { not: 'une liste' } });
    await expect(fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'alice')).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });

  it('le nom d’utilisateur est encodé dans l’adresse', async () => {
    const trakt = await serve({ 'GET /users/a%2Fb/watchlist/movie,show/added': [] });
    await fetchTraktWatchlist({ clientId: CLIENT_ID, baseUrl: trakt.url }, 'a/b');
    expect(trakt.requests[0]?.path).toBe('/users/a%2Fb/watchlist/movie,show/added');
  });
});

describe('testTrakt', () => {
  it('accepte une clé valide, refuse une clé rejetée avec un message lisible', async () => {
    const ok = await serve({ 'GET /movies/trending': [] });
    await expect(testTrakt({ clientId: CLIENT_ID, baseUrl: ok.url })).resolves.toEqual({ ok: true });

    const refused = await serve({ 'GET /movies/trending': status(403) });
    await expect(testTrakt({ clientId: 'mauvaise', baseUrl: refused.url })).rejects.toMatchObject({
      message: 'Client ID Trakt refusé',
    });
  });
});
