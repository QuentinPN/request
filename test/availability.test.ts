import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { migrationsFolder, openDataDir, openDb } from '../src/server/db/index.ts';
import { jobRuns, media, requests } from '../src/server/db/schema.ts';
import { createAvailability, displayStatus, libraryState, selectCached } from '../src/server/services/availability.ts';
import { failOrphanJobs, finishJob, startJob } from '../src/server/services/jobs.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { createTmdbProvider } from '../src/server/services/tmdb.ts';
import { upsertFromEmby } from '../src/server/services/users.ts';
import type { MediaKey } from '../src/shared/media.ts';
import { WATCH_LINK_PATH } from '../src/shared/media-server.ts';
import { type FakeRequest, type FakeRoutes, startFakeServer, status } from './fake-server.ts';
import {
  addArrServer,
  loginAs,
  loginAsOwner,
  pragma,
  queryPlan,
  trackTempDirs,
  truncatedMigrations,
} from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// --- Faux services ---

interface EmbyEntry {
  id: string;
  tmdb?: number;
  tvdb?: number;
  added?: string;
  /** Ids Emby des membres qui y ont accès (bibliothèque ou contrôle parental) ; absent = tous. */
  only?: string[];
  /** Série : épisodes présents par saison. */
  episodes?: Record<number, number>;
}
interface EmbyLibrary {
  movies?: EmbyEntry[];
  series?: EmbyEntry[];
}

const providerIds = (e: EmbyEntry) => ({
  ...(e.tmdb !== undefined && { Tmdb: String(e.tmdb) }),
  ...(e.tvdb !== undefined && { Tvdb: String(e.tvdb) }),
});

/** Faux Emby : recherche par ids de fournisseur, derniers ajouts et épisodes d'une série. */
function embyRoutes({ movies = [], series = [] }: EmbyLibrary): FakeRoutes {
  return {
    'GET /Library/VirtualFolders/Query': {
      Items: [
        { Name: 'Films', ItemId: 'films', CollectionType: 'movies' },
        { Name: 'Séries', ItemId: 'series', CollectionType: 'tvshows' },
      ],
      TotalRecordCount: 2,
    },
    'GET /Items': (req, res) => {
      const q = req.query;
      const typed = [...movies.map((e) => ({ ...e, Type: 'Movie' })), ...series.map((e) => ({ ...e, Type: 'Series' }))];
      if (q.IncludeItemTypes === 'Episode') {
        const show = series.find((s) => s.id === q.ParentId);
        const Items = Object.entries(show?.episodes ?? {}).flatMap(([season, count]) =>
          Array.from({ length: count }, (_, i) => ({ Id: `${season}-${i}`, ParentIndexNumber: Number(season) })),
        );
        return status(200, { Items })(req, res);
      }
      if (q.SortBy === 'DateCreated') {
        const Items = typed
          .filter((e) => !e.only || e.only.includes(q.UserId ?? ''))
          .sort((a, b) => (b.added ?? '').localeCompare(a.added ?? ''))
          .map((e) => ({ Id: e.id, Type: e.Type, DateCreated: e.added, ProviderIds: providerIds(e) }));
        return status(200, { Items })(req, res);
      }
      const wanted = new Set(q.AnyProviderIdEquals?.split(','));
      const Items = typed
        .filter((e) => e.Type === q.IncludeItemTypes)
        .filter((e) => wanted.has(`tmdb.${e.tmdb}`) || wanted.has(`tvdb.${e.tvdb}`))
        .map((e) => ({ Id: e.id, Name: e.id, ProviderIds: providerIds(e) }));
      return status(200, { Items })(req, res);
    },
  };
}

const queue = (records: Array<Record<string, number>>) => ({
  totalRecords: records.length,
  records: records.map((r) => ({ size: 1000, status: 'downloading', ...r })),
});

const radarrRoutes = (
  movies: Array<{ id: number; tmdbId: number; hasFile?: boolean }>,
  records: Array<Record<string, number>> = [],
): FakeRoutes => ({
  'GET /api/v3/movie': movies.map((m) => ({ hasFile: false, monitored: true, ...m })),
  'GET /api/v3/queue': queue(records),
});

/** `aired` : épisodes déjà diffusés (`episodeCount` de Sonarr), par défaut tous. */
type SonarrSeason = [season: number, files: number, total: number, aired?: number];
const sonarrRoutes = (
  series: Array<{ id: number; tvdbId: number; tmdbId?: number; seasons: SonarrSeason[] }>,
  records: Array<Record<string, number>> = [],
): FakeRoutes => ({
  'GET /api/v3/series': series.map(({ seasons, ...s }) => ({
    monitored: true,
    ...s,
    seasons: seasons.map(([seasonNumber, episodeFileCount, totalEpisodeCount, aired = totalEpisodeCount]) => ({
      seasonNumber,
      monitored: true,
      statistics: { episodeFileCount, episodeCount: aired, totalEpisodeCount },
    })),
  })),
  'GET /api/v3/queue': queue(records),
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const NOW = Date.parse('2026-11-17T10:00:00Z');

interface Upstreams {
  emby?: FakeRoutes;
  radarr?: FakeRoutes;
  sonarr?: FakeRoutes;
  tmdb?: FakeRoutes;
  libraryIds?: string[];
  publicUrl?: string;
}

/** Dossier de données branché sur les faux services fournis (les autres restent non configurés). */
async function setupData({ emby, radarr, sonarr, tmdb = {}, libraryIds = [], publicUrl }: Upstreams) {
  const start = async (routes: FakeRoutes) => {
    const server = await startFakeServer(routes);
    cleanups.push(server.close);
    return server;
  };
  const servers = {
    tmdb: await start(tmdb),
    emby: emby ? await start(emby) : undefined,
    radarr: radarr ? await start(radarr) : undefined,
    sonarr: sonarr ? await start(sonarr) : undefined,
  };
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: V3_KEY });
  if (servers.emby)
    setSetting(db, cryptoKey, 'emby', {
      url: servers.emby.url,
      apiKey: 'k',
      libraryIds,
      ...(publicUrl && { publicUrl }),
    });
  if (servers.radarr) addArrServer(data, { type: 'radarr', url: servers.radarr.url });
  if (servers.sonarr) addArrServer(data, { type: 'sonarr', url: servers.sonarr.url });
  return { data, servers };
}

/** Service seul, avec une horloge réglable. */
async function setup(upstreams: Upstreams = {}) {
  const { data, servers } = await setupData(upstreams);
  cleanups.push(() => data.db.$client.close(true));
  const clock = { now: NOW };
  const availability = createAvailability(data, {
    tmdb: createTmdbProvider(data, servers.tmdb.url),
    now: () => clock.now,
  });
  const calls = () => ({
    emby: servers.emby?.requests.length ?? 0,
    radarr: servers.radarr?.requests.length ?? 0,
    sonarr: servers.sonarr?.requests.length ?? 0,
    tmdb: servers.tmdb.requests.length,
  });
  return { data, servers, clock, availability, calls };
}

/** Application complète (routes du catalogue) sur les faux services. */
async function setupApp(upstreams: Upstreams) {
  const { data, servers } = await setupData(upstreams);
  const app = await buildApp({ data, upstreams: { tmdbUrl: servers.tmdb.url } });
  cleanups.push(() => app.close());
  const { headers } = await loginAsOwner(app);
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  return { app, servers, get };
}

const movie = (tmdbId: number): MediaKey => ({ type: 'movie', tmdbId });
const tv = (tmdbId: number): MediaKey => ({ type: 'tv', tmdbId });
const providerQuery = (req: FakeRequest) => req.query.AnyProviderIdEquals;

// --- Calcul ---

describe('calcul du statut', () => {
  it('film : Emby l’emporte sur la file (mise à niveau), la file sur l’absence', () => {
    expect(libraryState('movie', { inEmby: true, queue: [0.2] })).toEqual({ status: 'available' });
    expect(libraryState('movie', { inEmby: false, queue: [0.2, 0.6] })).toEqual({
      status: 'downloading',
      progress: 0.4,
    });
    expect(libraryState('movie', { inEmby: false, hasFile: true, queue: [] })).toEqual({ status: 'available' });
    expect(libraryState('movie', { inEmby: false, queue: [] })).toBeNull();
  });

  it('série : spéciaux et saisons à venir ne comptent pas', () => {
    const season = (seasonNumber: number, present: number, expected: number) => ({
      seasonNumber,
      present,
      expected,
      queue: [],
    });
    const facts = (seasons: ReturnType<typeof season>[]) => ({ inEmby: true, queue: [], seasons });
    expect(libraryState('tv', facts([season(0, 0, 9), season(1, 7, 7), season(2, 0, 0)]))).toEqual({
      status: 'available',
    });
    expect(libraryState('tv', facts([season(1, 7, 7), season(2, 3, 13)]))).toEqual({ status: 'partial' });
    expect(libraryState('tv', { inEmby: false, queue: [], seasons: [season(1, 0, 7)] })).toBeNull();
  });

  it('fusion : la part « demandes » (4.1) se pose sur la bibliothèque sans la contredire', () => {
    expect(displayStatus(null, null)).toEqual({});
    expect(displayStatus({ status: 'available' }, { status: 'pending' })).toEqual({ status: 'available' });
    expect(displayStatus({ status: 'partial' }, { status: 'pending' })).toEqual({ status: 'pending' });
    expect(displayStatus({ status: 'partial' }, null)).toEqual({ status: 'partial' });
  });
});

// --- Statuts par lot ---

/** Une page de 20 affiches : 10 films, 10 séries. */
const page = [
  ...Array.from({ length: 10 }, (_, i) => movie(101 + i)),
  ...Array.from({ length: 10 }, (_, i) => tv(201 + i)),
];
const library: Upstreams = {
  emby: embyRoutes({ movies: [{ id: 'e101', tmdb: 101 }], series: [{ id: 'e201', tmdb: 201 }] }),
  radarr: radarrRoutes(
    [
      { id: 2, tmdbId: 102 },
      { id: 3, tmdbId: 103, hasFile: true },
    ],
    [{ movieId: 2, sizeleft: 250 }],
  ),
  sonarr: sonarrRoutes(
    [
      {
        id: 22,
        tvdbId: 9202,
        tmdbId: 202,
        seasons: [
          [0, 0, 4],
          [1, 7, 7],
          [2, 0, 13],
        ],
      },
      { id: 23, tvdbId: 9203, tmdbId: 203, seasons: [[1, 0, 8]] },
      {
        id: 24,
        tvdbId: 9204,
        tmdbId: 204,
        seasons: [
          [1, 8, 8],
          [2, 10, 10],
        ],
      },
      // En cours de diffusion, à jour : 4 épisodes diffusés sur 10 annoncés, tous présents.
      {
        id: 25,
        tvdbId: 9205,
        tmdbId: 205,
        seasons: [
          [1, 8, 8],
          [2, 4, 10, 4],
        ],
      },
    ],
    [
      { seriesId: 23, seasonNumber: 1, sizeleft: 500 },
      { seriesId: 23, seasonNumber: 1, sizeleft: 500 },
    ],
  ),
};

describe('statusesFor', () => {
  it('absent, disponible, partiel, en téléchargement (avec progression)', async () => {
    const { availability } = await setup(library);
    const statuses = await availability.statusesFor(page);

    expect(Object.fromEntries(statuses)).toEqual({
      'movie:101': { status: 'available', embyItemId: 'e101' }, // dans Emby
      'movie:102': { status: 'downloading', progress: 0.75 },
      'movie:103': { status: 'available' }, // fichier chez Radarr : pas dans Emby, rien à ouvrir
      'tv:201': { status: 'available', embyItemId: 'e201' }, // dans Emby, hors Sonarr
      'tv:202': { status: 'partial' },
      'tv:203': { status: 'downloading', progress: 0.5 },
      'tv:204': { status: 'available' },
      'tv:205': { status: 'available' },
    });
  });

  it('20 affiches : un nombre d’appels borné, aucun par affiche, puis le cache', async () => {
    const { availability, servers, calls } = await setup(library);
    await availability.statusesFor(page);

    // Emby : films par id TMDB, séries par id TMDB puis par id TVDB connu ; Radarr et Sonarr : liste + file ;
    // TMDB : rien (Sonarr v4 donne l'id TMDB de ses séries).
    expect(calls()).toEqual({ emby: 3, radarr: 2, sonarr: 2, tmdb: 0 });
    expect(servers.emby?.requests.map(providerQuery).sort()).toEqual([
      page
        .filter((k) => k.type === 'movie')
        .map((k) => `tmdb.${k.tmdbId}`)
        .join(','),
      page
        .filter((k) => k.type === 'tv')
        .map((k) => `tmdb.${k.tmdbId}`)
        .join(','),
      'tvdb.9202,tvdb.9203,tvdb.9204,tvdb.9205',
    ]);

    await availability.statusesFor(page);
    expect(calls()).toEqual({ emby: 3, radarr: 2, sonarr: 2, tmdb: 0 });
  });

  it('cherche dans Emby seulement dans les bibliothèques suivies', async () => {
    const { availability, servers } = await setup({ ...library, libraryIds: ['films', 'series'] });
    await availability.statusesFor(page);

    // Films et séries sont cherchés en parallèle : l'ordre d'arrivée n'est pas fixé.
    const parents = servers.emby?.requests
      .filter((r) => r.query.IncludeItemTypes)
      .map((r) => `${r.query.IncludeItemTypes}:${r.query.ParentId}`)
      .sort();
    expect(parents).toEqual(['Movie:films', 'Series:series', 'Series:series']); // séries : ids TMDB puis TVDB
  });

  it('série à jour avec une saison annoncée : disponible ; un épisode diffusé manquant : partiel', async () => {
    const { availability } = await setup({
      sonarr: sonarrRoutes([
        // Saison 3 annoncée : Sonarr la compte (total 10) mais aucun épisode diffusé.
        {
          id: 31,
          tvdbId: 9301,
          tmdbId: 301,
          seasons: [
            [1, 8, 8],
            [2, 6, 6],
            [3, 0, 10, 0],
          ],
        },
        {
          id: 32,
          tvdbId: 9302,
          tmdbId: 302,
          seasons: [
            [1, 8, 8],
            [2, 3, 10, 4],
          ],
        },
      ]),
    });
    const statuses = await availability.statusesFor([tv(301), tv(302)]);
    expect(Object.fromEntries(statuses)).toEqual({
      'tv:301': { status: 'available' },
      'tv:302': { status: 'partial' },
    });
  });

  it('durée de vie : 1 min pour un téléchargement, 5 min sinon ; seuls les titres périmés sont relus', async () => {
    const { availability, servers, clock } = await setup(library);
    await availability.statusesFor(page);

    clock.now += 61_000;
    await availability.statusesFor(page);
    expect(servers.emby?.requests.slice(3).map(providerQuery).sort()).toEqual(['tmdb.102', 'tmdb.203', 'tvdb.9203']);

    clock.now += 4 * 60_000;
    await availability.statusesFor(page);
    expect(
      servers.emby?.requests
        .slice(6)
        .map(providerQuery)
        .sort()
        .map((q) => q?.split(',').length),
    ).toEqual([10, 10, 4]);
  });

  it('Sonarr v3 (sans id TMDB) : l’id TVDB est demandé à TMDB, puis gardé en base', async () => {
    const { availability, data, calls } = await setup({
      sonarr: sonarrRoutes([{ id: 5, tvdbId: 9205, seasons: [[1, 6, 6]] }]),
      tmdb: {
        'GET /tv/205/external_ids': { tvdb_id: 9205 },
        'GET /tv/206/external_ids': { tvdb_id: null },
      },
    });
    const statuses = await availability.statusesFor([tv(205), tv(206)]);

    expect(Object.fromEntries(statuses)).toEqual({ 'tv:205': { status: 'available' } });
    expect(calls().tmdb).toBe(2);
    const row = selectCached(data.db, [tv(205)]).get();
    expect(row).toMatchObject({ tvdbId: 9205, sonarrId: 5, status: 'available' });
  });

  it('aucune intégration configurée : aucun statut, rien en base', async () => {
    const { availability, data } = await setup();
    expect((await availability.statusesFor(page)).size).toBe(0);
    expect(data.db.select().from(media).all()).toEqual([]);
  });

  it('service en panne : le cache est gardé tel quel, sans erreur', async () => {
    const { availability, data, servers, clock } = await setup({ emby: library.emby });
    await availability.statusesFor([movie(101)]);
    const before = selectCached(data.db, [movie(101)]).get();

    await servers.emby?.close();
    clock.now += 10 * 60_000;
    const statuses = await availability.statusesFor([movie(101), movie(999)]);

    expect(Object.fromEntries(statuses)).toEqual({ 'movie:101': { status: 'available', embyItemId: 'e101' } });
    expect(selectCached(data.db, [movie(101)]).get()).toEqual(before);
    expect(selectCached(data.db, [movie(999)]).get()).toBeUndefined();
  });
});

describe('lien vers Emby', () => {
  it('une série partielle déjà demandée garde son id Emby, alors que le statut affiché est « Demandé »', async () => {
    const { availability, data } = await setup({
      emby: embyRoutes({ series: [{ id: 'e7', tmdb: 7 }] }),
      sonarr: sonarrRoutes([{ id: 7, tvdbId: 97, tmdbId: 7, seasons: [[1, 3, 10]] }]),
    });
    expect(Object.fromEntries(await availability.statusesFor([tv(7)]))).toEqual({
      'tv:7': { status: 'partial', embyItemId: 'e7' },
    });

    const user = upsertFromEmby(data.db, { id: 'u1', name: 'Alice', avatar: null, isEmbyAdmin: false });
    const row = selectCached(data.db, [tv(7)]).get();
    data.db
      .insert(requests)
      .values({ mediaId: row?.id ?? 0, userId: user.id, status: 'sent' })
      .run();
    expect(Object.fromEntries(await availability.statusesFor([tv(7)]))).toEqual({
      'tv:7': { status: 'requested', embyItemId: 'e7' },
    });
  });

  it('un titre en téléchargement, ou absent d’Emby, n’en a pas', async () => {
    const { availability } = await setup(library);
    const statuses = await availability.statusesFor(page);
    expect(statuses.get('movie:102')).toEqual({ status: 'downloading', progress: 0.75 });
    expect(statuses.get('tv:204')).toEqual({ status: 'available' });
  });

  const withPublicUrl = (extra: FakeRoutes = {}) => ({
    emby: { ...embyRoutes({}), 'GET /System/Info/Public': { Id: 'srv-1' }, ...extra },
    publicUrl: 'https://tv.exemple.fr/',
  });

  it('adresse publique et id du serveur ; l’id n’est lu qu’une fois', async () => {
    const { availability, servers } = await setup(withPublicUrl());
    const expected = { kind: 'emby', publicUrl: 'https://tv.exemple.fr', serverId: 'srv-1' };
    expect(await availability.watchLink()).toEqual(expected);
    expect(await availability.watchLink()).toEqual(expected);
    expect(servers.emby?.requests.filter((r) => r.path === '/System/Info/Public')).toHaveLength(1);
  });

  it('pas d’adresse publique : pas de lien, et Emby n’est pas appelé', async () => {
    const { availability, servers } = await setup({ emby: { 'GET /System/Info/Public': { Id: 'srv-1' } } });
    expect(await availability.watchLink()).toBeNull();
    expect(servers.emby?.requests).toHaveLength(0);
  });

  it('Emby injoignable ou illisible : pas de lien, jamais d’erreur', async () => {
    const { availability } = await setup(withPublicUrl({ 'GET /System/Info/Public': status(500) }));
    expect(await availability.watchLink()).toBeNull();
  });

  it('GET /api/media-server/link : lisible par un simple membre, 401 sans session', async () => {
    const { app, servers } = await setupApp(withPublicUrl());
    const member = await loginAs(app, 'member');
    const res = await app.inject({ method: 'GET', url: WATCH_LINK_PATH, headers: member.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ link: { kind: 'emby', publicUrl: 'https://tv.exemple.fr', serverId: 'srv-1' } });
    expect(JSON.stringify(res.json())).not.toContain(servers.emby?.url ?? '?');
    expect((await app.inject({ method: 'GET', url: WATCH_LINK_PATH })).statusCode).toBe(401);
  });
});

// --- API ---

const tmdbPage = (results: unknown[]) => ({ page: 1, total_pages: 1, results });

describe('statuts dans les réponses du catalogue', () => {
  const discover: FakeRoutes = {
    'GET /trending/all/week': tmdbPage([{ id: 101, title: 'Dans Emby', media_type: 'movie' }]),
    'GET /movie/popular': tmdbPage([{ id: 102, title: 'En cours' }]),
    'GET /tv/popular': tmdbPage([{ id: 202, name: 'Partielle' }]),
    'GET /movie/upcoming': tmdbPage([{ id: 104, title: 'Bientôt' }]),
    'GET /movie/101': { id: 101, title: 'Dans Emby', release_date: '2020-01-01', poster_path: '/a.jpg' },
  };

  it('Découvrir : statut sur chaque affiche (un seul lot) et rangée « Ajoutés récemment dans Emby »', async () => {
    const { get, servers } = await setupApp({
      ...library,
      emby: embyRoutes({
        movies: [{ id: 'e101', tmdb: 101, added: '2026-11-10T00:00:00Z' }],
        series: [{ id: 'e300', tvdb: 1, added: '2026-11-12T00:00:00Z' }], // sans id TMDB : écartée
      }),
      tmdb: discover,
    });
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ id: string; title: string; items: Array<Record<string, unknown>> }>;
    expect(rows.map((r) => r.id)).toEqual(['trending', 'popular-movies', 'popular-tv', 'upcoming', 'emby-recent']);
    expect(rows[0]?.items[0]).toMatchObject({ tmdbId: 101, status: 'available' });
    expect(rows[1]?.items[0]).toMatchObject({ tmdbId: 102, status: 'downloading', progress: 0.75 });
    expect(rows[2]?.items[0]).toMatchObject({ tmdbId: 202, status: 'partial' });
    expect(rows[3]?.items[0]).not.toHaveProperty('status');
    expect(rows[4]).toMatchObject({
      title: 'Ajoutés récemment dans Emby',
      items: [{ tmdbId: 101, type: 'movie', title: 'Dans Emby', year: 2020, status: 'available' }],
    });
    // Emby : derniers ajouts + une recherche par type pour toute la page.
    const embyCalls = servers.emby?.requests ?? [];
    const latestCalls = embyCalls.filter((r) => r.query.SortBy === 'DateCreated');
    expect(latestCalls).toHaveLength(1);
    expect(latestCalls[0]?.query.UserId).toBe('proprietaire'); // Emby applique l'accès du membre connecté
    expect(embyCalls.filter((r) => r.query.AnyProviderIdEquals)).toHaveLength(3); // films, séries (TMDB, TVDB)
  });

  it('Découvrir : « Ajoutés récemment dans Emby » ne montre que ce que le membre voit dans Emby, gardé par membre', async () => {
    const { app, get, servers } = await setupApp({
      emby: embyRoutes({
        movies: [
          { id: 'e101', tmdb: 101, added: '2026-11-10T00:00:00Z', only: ['alice'] },
          { id: 'e102', tmdb: 102, added: '2026-11-09T00:00:00Z' },
        ],
      }),
      tmdb: {
        ...discover,
        'GET /movie/102': { id: 102, title: 'Pour tous', release_date: '2020-01-01' },
      },
    });
    const recentIds = async (headers: Record<string, string>) => {
      const res = await app.inject({ method: 'GET', url: '/api/discover', headers });
      const rows = res.json().rows as Array<{ id: string; items: Array<{ tmdbId: number }> }>;
      return rows.find((r) => r.id === 'emby-recent')?.items.map((i) => i.tmdbId);
    };
    const alice = await loginAs(app, 'member', 'alice');
    const bob = await loginAs(app, 'member', 'bob');

    expect(await recentIds(alice.headers)).toEqual([101, 102]);
    expect(await recentIds(bob.headers)).toEqual([102]);
    expect(
      (await get('/api/discover'))
        .json()
        .rows.at(-1)
        .items.map((i: { tmdbId: number }) => i.tmdbId),
    ).toEqual([102]); // admin : aussi filtré
    // Chaque membre a sa liste en cache : revisiter ne réinterroge pas Emby.
    const latestCalls = () => servers.emby?.requests.filter((r) => r.query.SortBy === 'DateCreated') ?? [];
    expect(latestCalls().map((r) => r.query.UserId)).toEqual(['alice', 'bob', 'proprietaire']);
    await recentIds(alice.headers);
    expect(latestCalls()).toHaveLength(3);
  });

  it('recherche, genre et plateforme portent le statut', async () => {
    const { get } = await setupApp({
      ...library,
      tmdb: {
        'GET /search/multi': tmdbPage([{ id: 101, title: 'Dans Emby', media_type: 'movie' }]),
        'GET /discover/movie': tmdbPage([{ id: 103, title: 'Fichier Radarr' }]),
      },
    });
    expect((await get('/api/search?q=x')).json().results[0]).toMatchObject({ tmdbId: 101, status: 'available' });
    expect((await get('/api/discover/movie?genres=28')).json().results[0]).toMatchObject({ status: 'available' });
    expect((await get('/api/discover/movie/provider/8')).json().results[0]).toMatchObject({ status: 'available' });
  });

  it('fiche d’une série : statut par saison (épisodes Emby face aux saisons TMDB)', async () => {
    const { get } = await setupApp({
      emby: embyRoutes({ series: [{ id: 'e1396', tvdb: 81189, episodes: { 1: 3, 2: 1 } }] }),
      tmdb: {
        'GET /tv/1396': {
          id: 1396,
          name: 'Breaking Bad',
          seasons: [
            { season_number: 1, episode_count: 3, air_date: '2008-01-20' },
            { season_number: 2, episode_count: 2, air_date: '2009-03-08' },
            { season_number: 3, episode_count: 4, air_date: '2010-03-21' },
          ],
          similar: tmdbPage([{ id: 1399, name: 'Better Call Saul' }]),
          external_ids: { tvdb_id: 81189 },
        },
      },
    });
    const res = await get('/api/media/tv/1396');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('partial');
    expect(body.embyItemId).toBe('e1396');
    expect(body.seasons).toEqual([
      {
        seasonNumber: 1,
        episodeCount: 3,
        airDate: '2008-01-20',
        status: 'available',
        episodes: { present: 3, expected: 3 },
      },
      {
        seasonNumber: 2,
        episodeCount: 2,
        airDate: '2009-03-08',
        status: 'partial',
        episodes: { present: 1, expected: 2 },
      },
      { seasonNumber: 3, episodeCount: 4, airDate: '2010-03-21' },
    ]);
    expect(body.similar[0]).not.toHaveProperty('status');
  });

  it('fiche : l’id du serveur multimédia est toujours présent, `null` si le titre n’y est pas disponible', async () => {
    const { get } = await setupApp({
      ...library,
      tmdb: {
        'GET /movie/101': { id: 101, title: 'Dans Emby' },
        'GET /movie/102': { id: 102, title: 'En téléchargement' },
        'GET /movie/999': { id: 999, title: 'Inconnu' },
      },
    });

    expect((await get('/api/media/movie/101')).json().embyItemId).toBe('e101');
    expect((await get('/api/media/movie/102')).json().embyItemId).toBeNull();
    expect((await get('/api/media/movie/999')).json().embyItemId).toBeNull();
  });

  it('fiche : sans serveur multimédia configuré, l’id est `null`', async () => {
    const { get } = await setupApp({ tmdb: { 'GET /movie/101': { id: 101, title: 'Dans Emby' } } });

    expect((await get('/api/media/movie/101')).json()).toHaveProperty('embyItemId', null);
  });

  it('fiche : une série partielle déjà demandée garde son id, alors que le statut affiché est « Demandé »', async () => {
    const { app, get } = await setupApp({
      emby: embyRoutes({ series: [{ id: 'e7', tmdb: 7 }] }),
      sonarr: sonarrRoutes([{ id: 7, tvdbId: 97, tmdbId: 7, seasons: [[1, 3, 10]] }]),
      tmdb: { 'GET /tv/7': { id: 7, name: 'Partielle', seasons: [{ season_number: 1, episode_count: 10 }] } },
    });
    expect((await get('/api/media/tv/7')).json()).toMatchObject({ status: 'partial', embyItemId: 'e7' });

    const user = upsertFromEmby(app.data.db, { id: 'u1', name: 'Alice', avatar: null, isEmbyAdmin: false });
    const row = selectCached(app.data.db, [tv(7)]).get();
    app.data.db
      .insert(requests)
      .values({ mediaId: row?.id ?? 0, userId: user.id, status: 'sent' })
      .run();

    expect((await get('/api/media/tv/7')).json()).toMatchObject({ status: 'requested', embyItemId: 'e7' });
  });

  it('fiche : épisodes attendus d’une saison en cours = ceux déjà diffusés (dernier épisode diffusé de TMDB)', async () => {
    const { get } = await setupApp({
      emby: embyRoutes({ series: [{ id: 'e60', tvdb: 6, episodes: { 1: 8, 2: 4 } }] }),
      tmdb: {
        'GET /tv/60': {
          id: 60,
          name: 'En cours de diffusion',
          last_episode_to_air: { season_number: 2, episode_number: 4 },
          seasons: [
            { season_number: 1, episode_count: 8, air_date: '2020-01-01' },
            { season_number: 2, episode_count: 10, air_date: '2021-01-01' },
            { season_number: 3, episode_count: 10, air_date: '2022-01-01' },
          ],
          external_ids: { tvdb_id: 6 },
        },
      },
    });
    const body = (await get('/api/media/tv/60')).json();
    expect(body.status).toBe('available');
    expect(body.seasons.map((s: { status?: string; episodes?: object }) => [s.status, s.episodes])).toEqual([
      ['available', { present: 8, expected: 8 }],
      ['available', { present: 4, expected: 4 }],
      [undefined, undefined],
    ]);
    // Cache : relue sans nouvel appel Emby, les décomptes viennent de la base.
    expect((await get('/api/media/tv/60')).json().seasons[1].episodes).toEqual({ present: 4, expected: 4 });
  });

  it('fiche : une saison TMDB à venir n’est pas attendue, et le calcul est gardé en cache', async () => {
    const { get, servers } = await setupApp({
      emby: embyRoutes({ series: [{ id: 'e1', tvdb: 5, episodes: { 1: 3 } }] }),
      tmdb: {
        'GET /tv/50': {
          id: 50,
          name: 'À jour',
          seasons: [
            { season_number: 1, episode_count: 3, air_date: '2020-01-01' },
            { season_number: 2, episode_count: 8, air_date: '2999-01-01' },
            { season_number: 3, episode_count: 8 },
          ],
          external_ids: { tvdb_id: 5 },
        },
      },
    });
    expect((await get('/api/media/tv/50')).json().status).toBe('available');
    const calls = servers.emby?.requests.length;
    await get('/api/media/tv/50');
    expect(servers.emby?.requests.length).toBe(calls);
  });

  it('fiche : un appel Emby d’épisodes par série, quel que soit le nombre de saisons', async () => {
    const { get, servers } = await setupApp({
      emby: embyRoutes({ series: [{ id: 'e8', tvdb: 8, episodes: { 1: 2, 2: 2, 3: 2, 4: 1 } }] }),
      tmdb: {
        'GET /tv/80': {
          id: 80,
          name: 'Longue',
          seasons: [1, 2, 3, 4].map((n) => ({ season_number: n, episode_count: 2, air_date: '2020-01-01' })),
          external_ids: { tvdb_id: 8 },
        },
      },
    });
    await get('/api/media/tv/80');
    expect(servers.emby?.requests.filter((r) => r.query.IncludeItemTypes === 'Episode')).toHaveLength(1);
  });

  it('intégrations non configurées : la page est servie, sans statut', async () => {
    const { get } = await setupApp({ tmdb: discover });
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ id: string; items: object[] }>;
    expect(rows.map((r) => r.id)).not.toContain('emby-recent');
    for (const row of rows) for (const item of row.items) expect(item).not.toHaveProperty('status');
  });

  it('Emby en panne : Découvrir reste servi, et Emby n’est pas réinterrogé à chaque visite', async () => {
    const { get, servers } = await setupApp({ emby: { 'GET /Items': status(500) }, tmdb: discover });
    const res = await get('/api/discover');

    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { id: string }) => r.id)).toEqual([
      'trending',
      'popular-movies',
      'popular-tv',
      'upcoming',
    ]);
    const calls = servers.emby?.requests.length;
    expect((await get('/api/discover')).statusCode).toBe(200);
    expect(servers.emby?.requests.length).toBe(calls);
  });
});

// --- Base ---

describe('table media', () => {
  it('la lecture par lot des statuts utilise l’index (type, tmdb_id)', () => {
    const db = openDb(':memory:');
    expect(queryPlan(db, selectCached(db, page))).toContain(
      'USING INDEX media_type_tmdb_id_unique (type=? AND tmdb_id=?)',
    );
    db.$client.close(true);
  });

  it('refuse un type ou un statut inconnu', () => {
    const db = openDb(':memory:');
    const insert = (type: string, status: string | null) =>
      db.$client
        .prepare('insert into media (type, tmdb_id, status, status_updated_at) values (?, 1, ?, 0)')
        .run(type, status);
    expect(() => insert('anime', null)).toThrow(/CHECK constraint failed/);
    expect(() => insert('movie', 'perdu')).toThrow(/CHECK constraint failed/);
    expect(() => insert('movie', null)).not.toThrow();
    expect(() => insert('movie', 'available')).toThrow(/UNIQUE constraint failed/);
    db.$client.close(true);
  });

  it('migration 0003 sur une base existante : membres et sessions conservés', () => {
    const sqlite = new Database(join(tempDir(), 'avant.db'));
    pragma(sqlite, 'foreign_keys = ON');
    migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(tempDir(), 3) });
    sqlite.exec(`
      insert into users (id, name, role) values ('a', 'Alice', 'owner');
      insert into sessions (id, user_id, expires_at) values ('s1', 'a', 1900000000);
    `);

    migrate(drizzle({ client: sqlite }), { migrationsFolder });

    expect(sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('select role from users').get()).toEqual({ role: 'owner' });
    const tables = sqlite.prepare("select name from sqlite_master where type = 'table' order by name").all();
    expect(tables).toEqual(expect.arrayContaining([{ name: 'media' }, { name: 'seasons' }, { name: 'job_runs' }]));
    sqlite.close(true);
  });
});

describe('job_runs', () => {
  it('verrou : un second démarrage de la même tâche est refusé tant que la première tourne', () => {
    const db = openDb(':memory:');
    const first = startJob(db, 'balayage');
    expect(first).toBeTypeOf('number');
    expect(startJob(db, 'balayage')).toBeNull();
    expect(startJob(db, 'purge')).toBeTypeOf('number'); // une autre tâche n'est pas bloquée

    finishJob(db, first as number, 'success');
    expect(startJob(db, 'balayage')).toBeTypeOf('number');
    db.$client.close(true);
  });

  it('au démarrage du serveur, une exécution orpheline passe en échec et libère le verrou', async () => {
    const dir = tempDir();
    const before = openDataDir(dir);
    startJob(before.db, 'balayage');
    before.db.$client.close(true);

    const data = openDataDir(dir);
    const app = await buildApp({ data });
    cleanups.push(() => app.close());

    expect(data.db.select().from(jobRuns).all()).toMatchObject([
      { job: 'balayage', status: 'failed', detail: 'Interrompue par un redémarrage du serveur' },
    ]);
    expect(failOrphanJobs(data.db)).toBe(0);
    expect(startJob(data.db, 'balayage')).toBeTypeOf('number');
  });
});
