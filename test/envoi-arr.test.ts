import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { migrationsFolder, openDataDir } from '../src/server/db/index.ts';
import { users } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import type { ArrServerInput } from '../src/shared/arr-servers.ts';
import type { RequestDetail, SendOptions } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import { type FakeRoutes, status } from './fake-server.ts';
import { fakeTagRoutes } from './fake-tags.ts';
import {
  addArrServer,
  loginAs,
  pragma,
  SLOW_TEST,
  trackFakeServers,
  trackTempDirs,
  truncatedMigrations,
} from './helpers.ts';

const startServer = trackFakeServers();
const tempDir = trackTempDirs();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};
const ANIME_KEYWORD = { id: 210024, name: 'anime' };
const show = (id: number, name: string, tvdbId: number, keywords: Array<{ id: number; name: string }> = []) => ({
  id,
  name,
  first_air_date: '2008-01-20',
  overview: 'Une série.',
  seasons: [
    { season_number: 1, episode_count: 7, air_date: '2008-01-20' },
    { season_number: 2, episode_count: 13, air_date: '2009-03-08' },
  ],
  external_ids: { imdb_id: '', tvdb_id: tvdbId },
  keywords: { results: keywords },
});
const breakingBad = show(1396, 'Breaking Bad', 81189);
const frieren = show(209867, 'Frieren', 424536, [ANIME_KEYWORD]);

const arrOptions = (): FakeRoutes => ({
  'GET /api/v3/qualityprofile': [
    { id: 1, name: 'HD-1080p' },
    { id: 2, name: 'HD-720p' },
    { id: 5, name: 'Ultra-HD' },
  ],
  'GET /api/v3/rootfolder': [
    { id: 1, path: '/films', freeSpace: 1000 },
    { id: 2, path: '/series', freeSpace: 1000 },
    { id: 3, path: '/anime', freeSpace: 2000 },
  ],
});

const radarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/movie': [],
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  ...arrOptions(),
  ...overrides,
});

const lookupOf = (tvdbId: number, id = 0) => [
  { id, title: 'Série', tvdbId, seasons: [1, 2].map((seasonNumber) => ({ seasonNumber, monitored: false })) },
];
const sonarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/series': [],
  'GET /api/v3/series/lookup': (req, res) =>
    status(200, lookupOf(req.query.term === 'tvdb:424536' ? 424536 : 81189))(req, res),
  'POST /api/v3/series': { id: 7, monitored: true, seasons: [] },
  ...arrOptions(),
  ...overrides,
});

interface Actor {
  user: { id: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
}

/** Appli branchée sur un faux TMDB, un faux Radarr et un faux Sonarr, dont les serveurs enregistrés reçoivent `radarr` et `sonarr`. */
async function setup({
  radarr = {},
  sonarr = {},
  radarrRoutesOverride,
  sonarrRoutesOverride,
  tmdbRoutesOverride,
}: {
  radarr?: Partial<ArrServerInput>;
  sonarr?: Partial<ArrServerInput>;
  radarrRoutesOverride?: FakeRoutes;
  sonarrRoutesOverride?: FakeRoutes;
  tmdbRoutesOverride?: FakeRoutes;
} = {}) {
  const servers = {
    tmdb: await startServer({
      'GET /movie/603': matrix,
      'GET /tv/1396': breakingBad,
      'GET /tv/209867': frieren,
      ...tmdbRoutesOverride,
    }),
    radarr: await startServer(radarrRoutes(radarrRoutesOverride)),
    sonarr: await startServer(sonarrRoutes(sonarrRoutesOverride)),
  };
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const radarrServer = addArrServer(data, {
    type: 'radarr',
    url: servers.radarr.url,
    rootFolderPath: '/films',
    ...radarr,
  });
  const sonarrServer = addArrServer(data, {
    type: 'sonarr',
    url: servers.sonarr.url,
    qualityProfileId: 2,
    rootFolderPath: '/series',
    ...sonarr,
  });
  const app = await buildApp({ data, upstreams: { tmdbUrl: servers.tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string, name?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    if (name) data.db.update(users).set({ name }).where(eq(users.id, user.id)).run();
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
    };
  };
  /** Le membre demande, le propriétaire approuve : renvoie la demande envoyée (ou en échec). */
  const sendTitle = async (type: 'movie' | 'tv', tmdbId: number, memberId?: string, memberName?: string) => {
    const member = await as('member', memberId, memberName);
    const owner = await as('owner', 'proprietaire');
    const created = await member.post('/api/requests', { type, tmdbId, ...(type === 'tv' && { seasons: [1] }) });
    const { id } = created.json<RequestDetail>();
    return (await owner.post(`/api/requests/${id}/approve`)).json<RequestDetail>();
  };
  return { app, data, servers, as, sendTitle, radarrServer, sonarrServer };
}

const posted = (server: { requests: Array<{ method: string; path: string; body: unknown }> }, path: string) =>
  server.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body as Record<string, unknown>);

const sent = (
  server: { requests: Array<{ method: string; path: string; body: unknown }> },
  method: string,
  path: string,
) =>
  server.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body as Record<string, unknown>);

/** Série déjà suivie par Sonarr (id 7) : lecture, mise à jour et commandes de recherche. */
const knownSeries = (tags: number[]): FakeRoutes => ({
  'GET /api/v3/series/lookup': lookupOf(81189, 7),
  'GET /api/v3/series/7': { id: 7, monitored: true, tags, seasons: [{ seasonNumber: 1, monitored: false }] },
  'PUT /api/v3/series/7': {},
  'POST /api/v3/command': {},
});

describe('étiquettes du serveur', () => {
  it('un film envoyé reçoit les étiquettes du serveur', async () => {
    const { sendTitle, servers } = await setup({ radarr: { tags: [3, 4] } });
    expect((await sendTitle('movie', 603)).status).toBe('sent');
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ tags: [3, 4] }]);
  });

  it('une série envoyée reçoit les étiquettes du serveur', async () => {
    const { sendTitle, servers } = await setup({ sonarr: { tags: [5] } });
    expect((await sendTitle('tv', 1396)).status).toBe('sent');
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([{ tags: [5] }]);
  });

  it('série déjà dans Sonarr : les étiquettes du serveur s’ajoutent à celles qu’elle porte, sans les retirer', async () => {
    const { sendTitle, servers } = await setup({ sonarr: { tags: [5, 6] }, sonarrRoutesOverride: knownSeries([9, 5]) });
    expect((await sendTitle('tv', 1396)).status).toBe('sent');
    expect(sent(servers.sonarr, 'PUT', '/api/v3/series/7')).toMatchObject([{ tags: [9, 5, 6] }]);
  });
});

describe('étiquette du membre', () => {
  it('créée au format <id>-<nom> sans accent ni espace, avec les étiquettes du serveur', async () => {
    const { routes, tags } = fakeTagRoutes([{ id: 1, label: 'vip' }]);
    const { sendTitle, servers } = await setup({
      radarr: { tags: [1], tagRequester: true },
      radarrRoutesOverride: routes,
    });
    expect((await sendTitle('movie', 603, 'Emb-1', 'Zoé Dupont')).status).toBe('sent');
    expect(tags).toEqual([
      { id: 1, label: 'vip' },
      { id: 2, label: 'emb-1-zoe-dupont' },
    ]);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ tags: [1, 2] }]);
  });

  it('un membre qui envoie deux titres : une seule étiquette créée, réutilisée ensuite', async () => {
    const { routes, tags } = fakeTagRoutes();
    const { sendTitle, servers } = await setup({
      radarr: { tagRequester: true },
      radarrRoutesOverride: routes,
      sonarr: { tagRequester: true },
      sonarrRoutesOverride: routes,
    });
    await sendTitle('movie', 603, 'm1', 'Léa');
    await sendTitle('tv', 1396, 'm1', 'Léa');
    // Les deux faux serveurs partagent la liste : l'étiquette n'est créée qu'au premier envoi.
    expect(tags).toEqual([{ id: 1, label: 'm1-lea' }]);
    expect(sent(servers.radarr, 'POST', '/api/v3/tag')).toHaveLength(1);
    expect(sent(servers.sonarr, 'POST', '/api/v3/tag')).toHaveLength(0);
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([{ tags: [1] }]);
  });

  it('retrouve l’étiquette existante d’un membre renommé, y compris au format de Seerr avec espaces', async () => {
    const { routes, tags } = fakeTagRoutes([{ id: 8, label: 'm1 - ancien-nom' }]);
    const { sendTitle, servers } = await setup({ radarr: { tagRequester: true }, radarrRoutesOverride: routes });
    await sendTitle('movie', 603, 'm1', 'Nouveau Nom');
    expect(tags).toHaveLength(1);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ tags: [8] }]);
  });

  it('création concurrente refusée (libellé déjà pris) : l’étiquette créée entre-temps est reprise', async () => {
    const { routes, tags } = fakeTagRoutes();
    let listed = 0;
    const { sendTitle, servers } = await setup({
      radarr: { tagRequester: true },
      radarrRoutesOverride: {
        ...routes,
        // La première lecture ne voit rien ; entre-temps un autre envoi crée l'étiquette.
        'GET /api/v3/tag': (req, res) => {
          if (listed++ === 0) {
            tags.push({ id: 4, label: 'm1-lea' });
            return status(200, [])(req, res);
          }
          return status(200, tags)(req, res);
        },
      },
    });
    expect((await sendTitle('movie', 603, 'm1', 'Léa')).status).toBe('sent');
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ tags: [4] }]);
  });

  it('étiquette impossible à créer : l’envoi échoue, rien n’est ajouté à Radarr', async () => {
    const { routes } = fakeTagRoutes();
    const { sendTitle, servers } = await setup({
      radarr: { tagRequester: true },
      radarrRoutesOverride: { ...routes, 'POST /api/v3/tag': status(500) },
    });
    expect((await sendTitle('movie', 603)).status).toBe('failed');
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(0);
  });

  it('étiquette impossible à créer : le message nomme l’étape et le serveur', async () => {
    const { routes } = fakeTagRoutes();
    const { sendTitle } = await setup({
      sonarr: { tagRequester: true },
      sonarrRoutesOverride: { ...routes, 'POST /api/v3/tag': status(500) },
    });
    const request = await sendTitle('tv', 1396, 'm1', 'Léa');
    expect(request.status).toBe('failed');
    expect(JSON.stringify(request.events)).toContain('Création du tag du membre dans Sonarr impossible : ');
  });

  it('identifiants à tirets : le libellé exact du membre l’emporte sur le préfixe d’un autre identifiant', async () => {
    const { routes, tags } = fakeTagRoutes([
      { id: 1, label: 'ab-cd-bob' },
      { id: 2, label: 'ab-al' },
    ]);
    const { sendTitle, servers } = await setup({ radarr: { tagRequester: true }, radarrRoutesOverride: routes });
    await sendTitle('movie', 603, 'ab', 'Al');
    expect(tags).toHaveLength(2);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ tags: [2] }]);
  });

  it('identifiant sans caractère utilisable : échec, aucune étiquette créée', async () => {
    const { routes, tags } = fakeTagRoutes();
    const { sendTitle } = await setup({ radarr: { tagRequester: true }, radarrRoutesOverride: routes });
    expect((await sendTitle('movie', 603, '---', 'Al')).status).toBe('failed');
    expect(tags).toHaveLength(0);
  });

  it('sans l’option, aucune étiquette n’est lue ni créée', async () => {
    const { routes } = fakeTagRoutes();
    const { sendTitle, servers } = await setup({ radarrRoutesOverride: routes });
    await sendTitle('movie', 603);
    expect(servers.radarr.requests.some((r) => r.path === '/api/v3/tag')).toBe(false);
  });
});

describe('rechercher à l’ajout', () => {
  it('activé par défaut : film et série partent avec recherche', async () => {
    const { sendTitle, servers } = await setup();
    await sendTitle('movie', 603);
    await sendTitle('tv', 1396);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ addOptions: { searchForMovie: true } }]);
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
      { addOptions: { searchForMissingEpisodes: true } },
    ]);
  });

  it('désactivé : le film et la série sont ajoutés sans recherche', async () => {
    const { sendTitle, servers } = await setup({ radarr: { searchOnAdd: false }, sonarr: { searchOnAdd: false } });
    expect((await sendTitle('movie', 603)).status).toBe('sent');
    expect((await sendTitle('tv', 1396)).status).toBe('sent');
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ addOptions: { searchForMovie: false } }]);
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
      { addOptions: { searchForMissingEpisodes: false } },
    ]);
  });

  it('série déjà dans Sonarr : aucune recherche de saison sans l’option, une par saison avec', async () => {
    const off = await setup({ sonarr: { searchOnAdd: false }, sonarrRoutesOverride: knownSeries([]) });
    expect((await off.sendTitle('tv', 1396)).status).toBe('sent');
    expect(sent(off.servers.sonarr, 'PUT', '/api/v3/series/7')).toHaveLength(1);
    expect(sent(off.servers.sonarr, 'POST', '/api/v3/command')).toHaveLength(0);

    const on = await setup({ sonarrRoutesOverride: knownSeries([]) });
    await on.sendTitle('tv', 1396);
    expect(sent(on.servers.sonarr, 'POST', '/api/v3/command')).toMatchObject([
      { name: 'SeasonSearch', seriesId: 7, seasonNumber: 1 },
    ]);
  });
});

describe('animes (Sonarr)', () => {
  const anime: Partial<ArrServerInput> = {
    tags: [1],
    seriesType: 'standard',
    languageProfileId: 3,
    animeQualityProfileId: 5,
    animeRootFolderPath: '/anime',
    animeSeriesType: 'anime',
    animeLanguageProfileId: 4,
    animeTags: [2],
  };

  it('une série d’animation (mot-clé TMDB) prend profil, dossier, type, langue et étiquettes anime', async () => {
    const { sendTitle, servers } = await setup({ sonarr: anime });
    expect(await sendTitle('tv', 209867)).toMatchObject({
      status: 'sent',
      qualityProfileId: 5,
      rootFolder: '/anime',
      seriesType: 'anime',
    });
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
      {
        tvdbId: 424536,
        qualityProfileId: 5,
        rootFolderPath: '/anime',
        seriesType: 'anime',
        languageProfileId: 4,
        tags: [2],
      },
    ]);
  });

  it('une autre série garde les réglages du serveur', async () => {
    const { sendTitle, servers } = await setup({ sonarr: anime });
    expect(await sendTitle('tv', 1396)).toMatchObject({
      qualityProfileId: 2,
      rootFolder: '/series',
      seriesType: 'standard',
    });
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
      { qualityProfileId: 2, rootFolderPath: '/series', seriesType: 'standard', languageProfileId: 3, tags: [1] },
    ]);
  });

  it('un réglage anime non renseigné garde celui du serveur ; l’étiquette du membre s’ajoute aux étiquettes anime', async () => {
    const { routes } = fakeTagRoutes([
      { id: 1, label: 'serie' },
      { id: 2, label: 'anime' },
    ]);
    const { sendTitle, servers } = await setup({
      sonarr: { tags: [1], animeTags: [2], animeSeriesType: 'anime', tagRequester: true },
      sonarrRoutesOverride: routes,
    });
    await sendTitle('tv', 209867, 'm3', 'Sam');
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
      { qualityProfileId: 2, rootFolderPath: '/series', seriesType: 'anime', tags: [2, 3] },
    ]);
  });

  it('sans réglage anime, une série d’animation est envoyée comme les autres', async () => {
    const { sendTitle, servers } = await setup({ sonarr: { tags: [1] } });
    expect(await sendTitle('tv', 209867)).toMatchObject({
      status: 'sent',
      qualityProfileId: 2,
      seriesType: 'standard',
    });
    expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([{ rootFolderPath: '/series', tags: [1] }]);
  });

  it('TMDB en panne : les options d’envoi passent avec les valeurs hors anime', async () => {
    const { as } = await setup({ sonarr: anime, tmdbRoutesOverride: { 'GET /tv/209867': status(500) } });
    const owner = await as('owner', 'proprietaire');
    const res = await owner.get('/api/requests/send-options/tv?tmdbId=209867');
    expect(res.statusCode).toBe(200);
    expect(res.json<SendOptions>()).toMatchObject({ anime: false, defaultFolder: '/series' });
  });

  it('options d’envoi : les valeurs par défaut de la série d’animation, et seulement pour elle', async () => {
    const { as } = await setup({ sonarr: anime });
    const owner = await as('owner', 'proprietaire');
    const options = async (query: string) =>
      (await owner.get(`/api/requests/send-options/tv${query}`)).json<SendOptions>();
    expect(await options('?tmdbId=209867')).toMatchObject({
      anime: true,
      defaultProfileId: 5,
      defaultFolder: '/anime',
    });
    expect(await options('?tmdbId=1396')).toMatchObject({
      anime: false,
      defaultProfileId: 2,
      defaultFolder: '/series',
    });
    expect(await options('')).toMatchObject({ anime: false, defaultProfileId: 2, defaultFolder: '/series' });
  });
});

describe('adresse externe', () => {
  it('les approbateurs voient l’adresse externe du serveur, jamais son adresse de connexion ni sa clé', async () => {
    const { as, servers } = await setup({ radarr: { externalUrl: 'https://radarr.exemple.fr' } });
    const manager = await as('manager', 'gestionnaire');
    const res = await manager.get('/api/requests/send-options/movie');
    expect(res.json<SendOptions>().servers).toEqual([
      { id: 1, name: 'Radarr', is4k: false, isDefault: true, externalUrl: 'https://radarr.exemple.fr' },
    ]);
    expect(res.body).not.toContain(servers.radarr.url);
  });
});

describe('migration 0012 sur une base existante', () => {
  it(
    'garde les serveurs et leurs demandes (server_id), avec les valeurs par défaut des nouveaux réglages',
    SLOW_TEST,
    () => {
      const sqlite = new Database(join(tempDir(), 'avant.db'));
      pragma(sqlite, 'foreign_keys = ON');
      cleanups.push(() => sqlite.close(true));
      migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(tempDir(), 12) });
      sqlite.exec(`
      insert into arr_servers (id, type, name, url, api_key, is_default, quality_profile_id, root_folder_path, tags)
        values (1, 'sonarr', 'Sonarr', 'http://sonarr:8989', 'chiffree', 1, 2, '/series', '[4]');
      insert into users (id, name) values ('u', 'U');
      insert into media (id, type, tmdb_id, status_updated_at) values (1, 'tv', 20, 0);
      insert into requests (id, media_id, user_id, status, server_id) values (1, 1, 'u', 'sent', 1);
    `);

      migrate(drizzle({ client: sqlite }), { migrationsFolder });

      expect(sqlite.prepare('select server_id from requests').all()).toEqual([{ server_id: 1 }]);
      expect(sqlite.prepare('select * from arr_servers').all()).toEqual([
        expect.objectContaining({
          id: 1,
          api_key: 'chiffree',
          tags: '[4]',
          tag_requester: 0,
          search_on_add: 1,
          external_url: null,
          anime_quality_profile_id: null,
          anime_root_folder_path: null,
          anime_series_type: null,
          anime_language_profile_id: null,
          anime_tags: '[]',
        }),
      ]);
      // Les contrôles des nouvelles colonnes sont en place.
      const insert = (columns: string, value: string) =>
        sqlite.prepare(
          `insert into arr_servers (type, name, url, api_key, quality_profile_id, root_folder_path, ${columns}) values ('sonarr', 'x', 'u', 'k', 1, '/', ${value})`,
        );
      expect(() => insert('anime_series_type', "'inconnu'").run()).toThrow(/CHECK/);
      expect(() => insert('anime_tags', "'{}'").run()).toThrow(/CHECK/);
    },
  );
});
