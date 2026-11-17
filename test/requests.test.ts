import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir, openDb } from '../src/server/db/index.ts';
import { media, requestSeasons, requests } from '../src/server/db/schema.ts';
import { requestStatesFor } from '../src/server/services/availability.ts';
import {
  ACTIVE_CONFLICT,
  lastFailureQuery,
  quotaUsageQuery,
  requestPageQuery,
  requestTotalsQuery,
} from '../src/server/services/requests.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { setQuotaOverride, upsertFromEmby } from '../src/server/services/users.ts';
import type { MediaType } from '../src/shared/media.ts';
import type { RequestDetail, RequestPage, SendOptions } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import type { RequestStatus } from '../src/shared/status.ts';
import { type FakeRoutes, sequence, status } from './fake-server.ts';
import { loginAs, queryPlan, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const DAY_MS = 24 * 3600 * 1000;

// --- Faux services ---

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};
/** Saisons : 0 (spéciaux), 1 et 2 diffusées, 3 annoncée. */
const breakingBad = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  overview: 'Un professeur de chimie.',
  seasons: [
    { season_number: 0, episode_count: 9, air_date: null },
    { season_number: 1, episode_count: 7, air_date: '2008-01-20' },
    { season_number: 2, episode_count: 13, air_date: '2009-03-08' },
    { season_number: 3, episode_count: 10, air_date: '2099-01-01' },
  ],
  external_ids: { imdb_id: '', tvdb_id: 81189 },
};

const emptyQueue = { totalRecords: 0, records: [] };

/** Listes de l'approbation, communes au faux Radarr et au faux Sonarr. */
const arrOptionRoutes = (folder: string): FakeRoutes => ({
  'GET /api/v3/qualityprofile': [
    { id: 1, name: 'HD-1080p' },
    { id: 2, name: 'HD-720p' },
    { id: 5, name: 'Ultra-HD' },
  ],
  'GET /api/v3/rootfolder': [
    { id: 1, path: folder, freeSpace: 1000 },
    { id: 2, path: '/anime', freeSpace: 2000 },
  ],
});

const radarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/movie': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  ...arrOptionRoutes('/films'),
  ...overrides,
});

/** `seasons` de la série chez Sonarr : `[saison, fichiers, épisodes]`. */
const sonarrSeries = (seasons: Array<[number, number, number]>) => [
  {
    id: 7,
    tvdbId: 81189,
    tmdbId: 1396,
    monitored: true,
    seasons: seasons.map(([seasonNumber, episodeFileCount, episodeCount]) => ({
      seasonNumber,
      monitored: true,
      statistics: { episodeFileCount, episodeCount, totalEpisodeCount: episodeCount },
    })),
  },
];

const sonarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/series': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/series/lookup': [
    {
      id: 0,
      title: 'Breaking Bad',
      tvdbId: 81189,
      seasons: [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: false })),
    },
  ],
  'POST /api/v3/series': { id: 7, monitored: true, seasons: [] },
  ...arrOptionRoutes('/series'),
  ...overrides,
});

interface Actor {
  user: { id: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
}

/** Appli branchée sur un faux TMDB, un faux Radarr et un faux Sonarr. */
async function setup({
  radarr = radarrRoutes(),
  sonarr = sonarrRoutes(),
}: {
  radarr?: FakeRoutes;
  sonarr?: FakeRoutes;
} = {}) {
  const servers = {
    tmdb: await startServer({ 'GET /movie/603': matrix, 'GET /tv/1396': breakingBad }),
    radarr: await startServer(radarr),
    sonarr: await startServer(sonarr),
  };
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: V3_KEY });
  setSetting(db, cryptoKey, 'radarr', {
    url: servers.radarr.url,
    apiKey: 'k',
    qualityProfileId: 1,
    rootFolderPath: '/films',
  });
  setSetting(db, cryptoKey, 'sonarr', {
    url: servers.sonarr.url,
    apiKey: 'k',
    qualityProfileId: 2,
    rootFolderPath: '/series',
  });
  const app = await buildApp({ data, upstreams: { tmdbUrl: servers.tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
    };
  };
  return { app, db, servers, as };
}

const posted = (server: { requests: Array<{ method: string; path: string; body: unknown }> }, path: string) =>
  server.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body as Record<string, unknown>);

const eventTypes = (request: RequestDetail) => request.events.map((e) => e.type);

/** Demande écrite directement en base (listes, quotas) : `createdAt` choisi, titre créé au besoin. */
function seedRequest(
  db: Db,
  {
    userId,
    tmdbId,
    type = 'movie',
    status: requestStatus = 'pending',
    createdAt = new Date(),
    seasons = [],
  }: {
    userId: string;
    tmdbId: number;
    type?: MediaType;
    status?: RequestStatus;
    createdAt?: Date;
    seasons?: number[];
  },
) {
  const row = db
    .insert(media)
    .values({ type, tmdbId, statusUpdatedAt: new Date(0) })
    .onConflictDoUpdate({ target: [media.type, media.tmdbId], set: { type } })
    .returning()
    .get();
  const request = db
    .insert(requests)
    .values({ mediaId: row.id, userId, status: requestStatus, createdAt, updatedAt: createdAt })
    .returning()
    .get();
  for (const seasonNumber of seasons) db.insert(requestSeasons).values({ requestId: request.id, seasonNumber }).run();
  return request;
}

const countRequests = (db: Db) => db.select().from(requests).all().length;

// --- Création ---

describe('POST /api/requests', () => {
  it('crée une demande de film en attente, avec l’évènement « requested »', async () => {
    const { as, servers } = await setup();
    const member = await as('member');
    const res = await member.post('/api/requests', { type: 'movie', tmdbId: 603 });

    expect(res.statusCode).toBe(201);
    const request = res.json<RequestDetail>();
    expect(request).toMatchObject({
      type: 'movie',
      tmdbId: 603,
      status: 'pending',
      seasons: [],
      requester: { id: member.user.id },
      decidedBy: null,
      media: { title: 'Matrix', posterPath: '/matrix.jpg' },
    });
    expect(eventTypes(request)).toEqual(['requested']);
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(0);
  });

  it('série, « all » : seulement les saisons diffusées et encore manquantes', async () => {
    const { as } = await setup({ sonarr: sonarrRoutes({ 'GET /api/v3/series': sonarrSeries([[1, 7, 7]]) }) });
    const member = await as('member');
    const res = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: 'all' });

    expect(res.statusCode).toBe(201);
    // Saison 0 (spéciaux) et 3 (pas encore diffusée) exclues, saison 1 déjà disponible.
    expect(res.json<RequestDetail>().seasons).toEqual([2]);
  });

  it('série sans saisons précisées : « all » par défaut', async () => {
    const { as } = await setup();
    const res = await (await as('member')).post('/api/requests', { type: 'tv', tmdbId: 1396 });
    expect(res.json<RequestDetail>().seasons).toEqual([1, 2]);
  });

  it('refuse un film déjà disponible (409), sans rien créer', async () => {
    const { as, db } = await setup({
      radarr: radarrRoutes({ 'GET /api/v3/movie': [{ id: 42, tmdbId: 603, hasFile: true, monitored: true }] }),
    });
    const res = await (await as('member')).post('/api/requests', { type: 'movie', tmdbId: 603 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Ce titre est déjà disponible dans Emby' });
    expect(countRequests(db)).toBe(0);
  });

  it('refuse une série dont les saisons demandées sont toutes disponibles (409)', async () => {
    const { as } = await setup({
      sonarr: sonarrRoutes({
        'GET /api/v3/series': sonarrSeries([
          [1, 7, 7],
          [2, 13, 13],
        ]),
      }),
    });
    const member = await as('member');
    const res = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: 'all' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Ce titre est déjà disponible dans Emby' });
  });

  it('refuse une saison inconnue (400) et un titre inconnu de TMDB (404)', async () => {
    const { as } = await setup();
    const member = await as('member');
    expect((await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [9] })).statusCode).toBe(400);
    expect((await member.post('/api/requests', { type: 'movie', tmdbId: 603, seasons: [1] })).statusCode).toBe(400);
    const missing = await member.post('/api/requests', { type: 'movie', tmdbId: 999 });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Titre introuvable' });
  });

  it('saisons choisies : les spéciaux et les saisons pas encore diffusées sont refusés (400), comme avec « all »', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    for (const seasons of [[0], [3], [1, 3]]) {
      const res = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Les saisons spéciales et pas encore diffusées ne peuvent pas être demandées',
      });
    }
    expect(countRequests(db)).toBe(0);
  });

  it('double clic : deux POST identiques → une seule demande, la seconde renvoyée en 200', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    const body = { type: 'movie', tmdbId: 603 };
    const [a, b] = await Promise.all([member.post('/api/requests', body), member.post('/api/requests', body)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json<RequestDetail>().id).toBe(b.json<RequestDetail>().id);
    expect(countRequests(db)).toBe(1);
  });

  it('film déjà demandé par un autre membre : 409', async () => {
    const { as } = await setup();
    await (await as('member', 'a')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    const res = await (await as('member', 'b')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Ce titre est déjà demandé' });
  });

  it('série : les saisons déjà demandées par d’autres sont écartées, les siennes en attente s’enrichissent', async () => {
    const { as } = await setup();
    const a = await as('member', 'a');
    const b = await as('member', 'b');
    await a.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] });

    const other = await b.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: 'all' });
    expect(other.statusCode).toBe(201);
    expect(other.json<RequestDetail>().seasons).toEqual([2]);

    // Saison déjà demandée par A : refusée, même si B a sa propre demande en cours ; sa propre saison : double clic.
    expect((await b.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] })).statusCode).toBe(409);
    const twice = await b.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [2] });
    expect(twice.statusCode).toBe(200);
    expect(twice.json<RequestDetail>().id).toBe(other.json<RequestDetail>().id);

    const c = await as('member', 'c');
    const none = await c.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1, 2] });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: 'Ces saisons sont déjà demandées' });
  });

  it('série : les saisons demandées ensuite s’ajoutent à sa demande en attente', async () => {
    const { as } = await setup();
    const member = await as('member');
    const first = (
      await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] })
    ).json<RequestDetail>();

    const more = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [2] });
    expect(more.statusCode).toBe(200);
    expect(more.json<RequestDetail>()).toMatchObject({ id: first.id, seasons: [1, 2] });
    expect(more.json<RequestDetail>().events.at(-1)).toMatchObject({
      type: 'requested',
      detail: 'Saisons ajoutées : 2',
    });
  });

  it('série envoyée : une saison pas encore demandée crée une nouvelle demande, les autres restent refusées', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    const manager = await as('manager');
    const first = (
      await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] })
    ).json<RequestDetail>();
    const approved = await manager.post(`/api/requests/${first.id}/approve`, {});
    expect(approved.json<RequestDetail>().status).toBe('sent');

    const next = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [2] });
    expect(next.statusCode).toBe(201);
    expect(next.json<RequestDetail>()).toMatchObject({ status: 'pending', seasons: [2] });
    expect(next.json<RequestDetail>().id).not.toBe(first.id);
    expect(countRequests(db)).toBe(2);

    // La saison 1, envoyée, compte toujours comme demandée.
    const again = await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'Ces saisons sont déjà demandées' });
  });

  it('rôle à approbation automatique : approuvée et envoyée à Radarr aussitôt, avec recherche', async () => {
    const { as, db, servers } = await setup();
    const res = await (await as('auto_approve')).post('/api/requests', { type: 'movie', tmdbId: 603 });

    expect(res.statusCode).toBe(201);
    const request = res.json<RequestDetail>();
    expect(request).toMatchObject({ status: 'sent', qualityProfileId: 1, rootFolder: '/films' });
    expect(eventTypes(request)).toEqual(['requested', 'approved', 'sent']);
    expect(request.events.at(-1)?.detail).toBe('Radarr #42');
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([
      {
        tmdbId: 603,
        qualityProfileId: 1,
        rootFolderPath: '/films',
        monitored: true,
        addOptions: { searchForMovie: true },
      },
    ]);
    expect(db.select().from(media).where(eq(media.tmdbId, 603)).get()?.radarrId).toBe(42);
  });

  it('approbation automatique, double clic : l’appel perdant renvoie l’état actuel, sans 409', async () => {
    const { as, db } = await setup();
    const member = await as('auto_approve');
    const body = { type: 'movie', tmdbId: 603 };
    const calls = await Promise.all([member.post('/api/requests', body), member.post('/api/requests', body)]);

    expect(calls.map((c) => c.statusCode).sort()).toEqual([200, 201]);
    expect(calls[0]?.json<RequestDetail>().id).toBe(calls[1]?.json<RequestDetail>().id);
    expect(countRequests(db)).toBe(1);
  });
});

// --- Quotas ---

describe('quotas', () => {
  const NOW = Date.parse('2026-11-17T10:00:00Z');
  const windowStart = new Date(NOW - 7 * DAY_MS);
  const freezeTime = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  };
  const oneMovie = { movies: { limit: 1, days: 7 }, seasons: null };

  it('bord de fenêtre : une demande d’il y a exactement 7 jours compte, une seconde plus tôt non', async () => {
    freezeTime();
    const { as, db } = await setup();
    const inside = await as('member', 'dedans');
    const outside = await as('member', 'dehors');
    setQuotaOverride(db, inside.user.id, oneMovie);
    setQuotaOverride(db, outside.user.id, oneMovie);
    seedRequest(db, { userId: inside.user.id, tmdbId: 1, createdAt: windowStart });
    seedRequest(db, { userId: outside.user.id, tmdbId: 2, createdAt: new Date(windowStart.getTime() - 1000) });

    const refused = await inside.post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Quota atteint : 1 film sur 7 jours' });
    expect(countRequests(db)).toBe(2); // rien d'inséré

    expect((await outside.post('/api/requests', { type: 'movie', tmdbId: 603 })).statusCode).toBe(201);
  });

  it('quota par défaut des réglages, remplacé par celui du membre', async () => {
    const { as, app, db } = await setup();
    setSetting(db, app.data.cryptoKey, 'rules', {
      defaultQuota: { movies: { limit: 10, days: 7 }, seasons: { limit: 0, days: 30 } },
    });
    const member = await as('member');
    const refused = await member.post('/api/requests', { type: 'tv', tmdbId: 1396 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Quota atteint : 0 saison sur 30 jours' });

    setQuotaOverride(db, member.user.id, { movies: null, seasons: { limit: 1, days: 7 } });
    const partial = await member.post('/api/requests', { type: 'tv', tmdbId: 1396 });
    expect(partial.json()).toEqual({ error: 'Quota atteint : 1 saison sur 7 jours (il en reste 1)' });
    expect((await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [2] })).statusCode).toBe(201);
  });

  it.each([
    ['member', false, [409, 409]],
    ['manager', true, [201, 201]],
    ['owner', true, [201, 201]],
  ] as const)('%s : hors quotas = %s', async (role, exempt, statuses) => {
    const { as, db } = await setup();
    const client = await as(role);
    setQuotaOverride(db, client.user.id, { movies: { limit: 0, days: 7 }, seasons: { limit: 0, days: 7 } });

    const movie = await client.post('/api/requests', { type: 'movie', tmdbId: 603 });
    const show = await client.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] });
    expect([movie.statusCode, show.statusCode]).toEqual(statuses);
    expect((await client.get('/api/requests/quota')).json().exempt).toBe(exempt);
  });

  it('refusées et annulées ne comptent pas', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    setQuotaOverride(db, member.user.id, oneMovie);
    seedRequest(db, { userId: member.user.id, tmdbId: 1, status: 'declined' });
    seedRequest(db, { userId: member.user.id, tmdbId: 2, status: 'cancelled' });
    expect((await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).statusCode).toBe(201);
  });

  it('GET /api/requests/quota : quota restant du membre connecté', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    seedRequest(db, { userId: member.user.id, tmdbId: 1 });
    seedRequest(db, { userId: member.user.id, tmdbId: 1396, type: 'tv', seasons: [1, 2, 3] });

    const res = await member.get('/api/requests/quota');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      movies: { limit: 10, days: 7, used: 1, remaining: 9 },
      seasons: { limit: 10, days: 7, used: 3, remaining: 7 },
      exempt: false,
    });
  });

  it('les requêtes de quota passent par l’index (user_id, created_at)', () => {
    const db = openDb(':memory:');
    for (const kind of ['movies', 'seasons'] as const)
      expect(queryPlan(db, quotaUsageQuery(db, 'u', kind, new Date()))).toContain('requests_user_id_created_at_idx');
    db.$client.close();
  });
});

// --- Approbation, envoi, refus, annulation ---

describe('approbation et envoi', () => {
  it('un membre ne peut ni approuver, ni refuser, ni relancer (403)', async () => {
    const { as } = await setup();
    const member = await as('member');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    for (const action of ['approve', 'retry'])
      expect((await member.post(`/api/requests/${id}/${action}`)).statusCode).toBe(403);
    expect((await member.post(`/api/requests/${id}/decline`, { reason: 'non' })).statusCode).toBe(403);
    expect((await member.post('/api/requests/batch', { action: 'approve', ids: [id] })).statusCode).toBe(403);
  });

  it('approuve une série avec profil, dossier et type choisis : Sonarr reçoit les saisons demandées', async () => {
    const { as, db, servers } = await setup();
    const member = await as('member');
    const owner = await as('owner', 'proprietaire');
    const { id } = (await member.post('/api/requests', { type: 'tv', tmdbId: 1396 })).json<RequestDetail>();

    const res = await owner.post(`/api/requests/${id}/approve`, {
      qualityProfileId: 5,
      rootFolderPath: '/anime',
      seriesType: 'anime',
    });
    expect(res.statusCode).toBe(200);
    const request = res.json<RequestDetail>();
    expect(request).toMatchObject({
      status: 'sent',
      decidedBy: { id: owner.user.id },
      qualityProfileId: 5,
      rootFolder: '/anime',
      seriesType: 'anime',
    });
    expect(eventTypes(request)).toEqual(['requested', 'approved', 'sent']);
    const [sent] = posted(servers.sonarr, '/api/v3/series');
    expect(sent).toMatchObject({ tvdbId: 81189, qualityProfileId: 5, rootFolderPath: '/anime', seriesType: 'anime' });
    const monitored = (sent?.seasons ?? []) as Array<{ seasonNumber: number; monitored: boolean }>;
    expect(monitored.filter((s) => s.monitored).map((s) => s.seasonNumber)).toEqual([1, 2]);
    expect(sent?.addOptions).toMatchObject({ searchForMissingEpisodes: true });
    expect(db.select().from(media).where(eq(media.tmdbId, 1396)).get()?.sonarrId).toBe(7);

    // Déjà traitée : une seconde approbation est refusée, rien n'est renvoyé à Sonarr.
    expect((await owner.post(`/api/requests/${id}/approve`)).statusCode).toBe(409);
    expect(posted(servers.sonarr, '/api/v3/series')).toHaveLength(1);
  });

  it('échec d’envoi → « failed » avec un message lisible ; la relance réussit et complète la frise', async () => {
    const { as, servers } = await setup({
      radarr: radarrRoutes({ 'POST /api/v3/movie': sequence(status(500), status(201, { id: 42 })) }),
    });
    const member = await as('member');
    const owner = await as('owner', 'proprietaire');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

    const failed = (await owner.post(`/api/requests/${id}/approve`)).json<RequestDetail>();
    expect(failed.status).toBe('failed');
    expect(failed.events.at(-1)).toMatchObject({ type: 'failed', detail: 'Radarr a répondu par une erreur (500)' });

    // Une demande en échec reste « en cours » : le membre ne peut pas la dupliquer.
    expect((await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>().id).toBe(id);

    const retried = await owner.post(`/api/requests/${id}/retry`);
    expect(retried.statusCode).toBe(200);
    const request = retried.json<RequestDetail>();
    expect(request.status).toBe('sent');
    expect(eventTypes(request)).toEqual(['requested', 'approved', 'failed', 'retried', 'sent']);
    expect(request.events.map((e) => e.actor?.id)).toEqual([
      member.user.id,
      owner.user.id,
      owner.user.id,
      owner.user.id,
      owner.user.id,
    ]);
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(2);
    expect((await owner.post(`/api/requests/${id}/retry`)).statusCode).toBe(409);
  });

  it('profil ou dossier inconnu de Radarr : 400, la demande reste en attente et rien n’est envoyé', async () => {
    const { as, servers } = await setup();
    const owner = await as('owner', 'proprietaire');
    const { id } = (
      await (await as('member')).post('/api/requests', { type: 'movie', tmdbId: 603 })
    ).json<RequestDetail>();

    const badProfile = await owner.post(`/api/requests/${id}/approve`, { qualityProfileId: 99 });
    expect(badProfile.statusCode).toBe(400);
    expect(badProfile.json()).toEqual({ error: 'Profil de qualité inconnu de Radarr' });
    const badFolder = await owner.post(`/api/requests/${id}/approve`, { rootFolderPath: '/ailleurs' });
    expect(badFolder.json()).toEqual({ error: 'Dossier racine inconnu de Radarr' });
    expect((await owner.get(`/api/requests/${id}`)).json<RequestDetail>().status).toBe('pending');
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(0);

    const res = await owner.post(`/api/requests/${id}/approve`, { qualityProfileId: 5, rootFolderPath: '/anime' });
    expect(res.json<RequestDetail>()).toMatchObject({ status: 'sent', qualityProfileId: 5, rootFolder: '/anime' });
    expect(posted(servers.radarr, '/api/v3/movie')[0]).toMatchObject({ qualityProfileId: 5, rootFolderPath: '/anime' });
  });

  it('GET /api/requests/send-options/:type : profils et dossiers pour les approbateurs, sans adresse ni clé', async () => {
    const { as, db } = await setup();
    const expected: SendOptions = {
      qualityProfiles: [
        { id: 1, name: 'HD-1080p' },
        { id: 2, name: 'HD-720p' },
        { id: 5, name: 'Ultra-HD' },
      ],
      rootFolders: [
        { id: 1, path: '/series', freeSpace: 1000 },
        { id: 2, path: '/anime', freeSpace: 2000 },
      ],
      defaultProfileId: 2,
      defaultFolder: '/series',
    };
    for (const role of ['owner', 'manager'] as const) {
      const res = await (await as(role, role)).get('/api/requests/send-options/tv');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expected);
    }
    const manager = await as('manager', 'gestionnaire');
    expect((await manager.get('/api/requests/send-options/movie')).json<SendOptions>().defaultFolder).toBe('/films');
    expect((await manager.get('/api/requests/send-options/livre')).statusCode).toBe(400);
    expect((await (await as('member')).get('/api/requests/send-options/movie')).statusCode).toBe(403);

    db.$client.prepare("delete from settings where key = 'radarr'").run();
    const missing = await manager.get('/api/requests/send-options/movie');
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toEqual({ error: "Radarr n'est pas encore configuré" });
  });

  it('envoi interrompu par un redémarrage : la demande restée « approved » passe en échec, puis se relance', async () => {
    const { app, as, db, servers } = await setup();
    const owner = await as('owner', 'proprietaire');
    const { id } = (
      await (await as('member')).post('/api/requests', { type: 'movie', tmdbId: 603 })
    ).json<RequestDetail>();
    db.update(requests).set({ status: 'approved' }).where(eq(requests.id, id)).run();

    const restarted = await buildApp({ data: app.data, upstreams: { tmdbUrl: servers.tmdb.url } });
    cleanups.push(() => restarted.close());
    const failed = (await owner.get(`/api/requests/${id}`)).json<RequestDetail>();
    expect(failed.status).toBe('failed');
    expect(failed.events.at(-1)).toMatchObject({
      type: 'failed',
      actor: null,
      detail: 'Envoi interrompu (redémarrage) : à relancer',
    });
    expect((await owner.post(`/api/requests/${id}/retry`)).json<RequestDetail>().status).toBe('sent');
  });

  it('Radarr non configuré : la demande passe en échec avec un message clair', async () => {
    const { as, db } = await setup();
    db.$client.prepare("delete from settings where key = 'radarr'").run();
    const res = await (await as('auto_approve')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(res.json<RequestDetail>()).toMatchObject({ status: 'failed', qualityProfileId: null });
    expect(res.json<RequestDetail>().events.at(-1)?.detail).toBe("Radarr n'est pas encore configuré");
  });

  it('refus : motif obligatoire (500 caractères au plus), gardé sur la demande et dans la frise', async () => {
    const { as } = await setup();
    const member = await as('member');
    const owner = await as('owner', 'proprietaire');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    const decline = (body?: object) => owner.post(`/api/requests/${id}/decline`, body);

    expect((await decline()).statusCode).toBe(400);
    expect((await decline({ reason: '   ' })).statusCode).toBe(400);
    expect((await decline({ reason: 'x'.repeat(501) })).statusCode).toBe(400);

    const res = await decline({ reason: ' Déjà sur Netflix ' });
    expect(res.statusCode).toBe(200);
    const request = res.json<RequestDetail>();
    expect(request).toMatchObject({
      status: 'declined',
      declineReason: 'Déjà sur Netflix',
      decidedBy: { id: owner.user.id },
    });
    expect(request.events.at(-1)).toMatchObject({ type: 'declined', detail: 'Déjà sur Netflix' });
    // Refusée : le membre peut la redemander.
    expect((await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).statusCode).toBe(201);
  });

  it('annulation : par son auteur seulement, et tant qu’elle est en attente', async () => {
    const { as } = await setup();
    const member = await as('member', 'auteur');
    const other = await as('member', 'autre');
    const owner = await as('owner', 'proprietaire');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

    expect((await other.post(`/api/requests/${id}/cancel`)).statusCode).toBe(404);
    expect((await owner.post(`/api/requests/${id}/cancel`)).statusCode).toBe(403);

    const cancelled = await member.post(`/api/requests/${id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<RequestDetail>()).toMatchObject({ status: 'cancelled' });
    expect(eventTypes(cancelled.json())).toEqual(['requested', 'cancelled']);
    expect((await member.post(`/api/requests/${id}/cancel`)).statusCode).toBe(409);

    const again = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    await owner.post(`/api/requests/${again.id}/approve`);
    const late = await member.post(`/api/requests/${again.id}/cancel`);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'Cette demande ne peut plus être annulée' });
  });

  it('lot : chaque demande est traitée à part, une erreur n’arrête pas les autres', async () => {
    const { as } = await setup();
    const owner = await as('owner', 'proprietaire');
    const a = (
      await (await as('member', 'a')).post('/api/requests', { type: 'movie', tmdbId: 603 })
    ).json<RequestDetail>();
    const b = (
      await (await as('member', 'b')).post('/api/requests', { type: 'tv', tmdbId: 1396 })
    ).json<RequestDetail>();

    expect((await owner.post('/api/requests/batch', { action: 'decline', ids: [a.id] })).statusCode).toBe(400);
    const res = await owner.post('/api/requests/batch', { action: 'decline', ids: [a.id, 9999, b.id], reason: 'Non' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toMatchObject([
      { id: a.id, ok: true, request: { status: 'declined' } },
      { id: 9999, ok: false, error: 'Demande introuvable' },
      { id: b.id, ok: true, request: { status: 'declined' } },
    ]);
  });
});

// --- Lecture ---

describe('listes, fiche d’une demande et compteurs', () => {
  it('un membre ne voit que ses demandes ; pagination par 20, plus récentes d’abord', async () => {
    const { as, db } = await setup();
    const member = await as('member', 'a');
    const other = await as('member', 'b');
    const owner = await as('owner', 'proprietaire');
    const start = Date.now() - DAY_MS;
    for (let i = 0; i < 25; i++)
      seedRequest(db, { userId: member.user.id, tmdbId: 1000 + i, createdAt: new Date(start + i * 60_000) });
    seedRequest(db, { userId: other.user.id, tmdbId: 5000, status: 'declined' });

    const first = (await member.get('/api/requests?mine=false')).json();
    expect(first).toMatchObject({ page: 1, totalPages: 2 });
    expect(first.results).toHaveLength(20);
    expect(first.results[0]).toMatchObject({ tmdbId: 1024, requester: { id: member.user.id }, media: null });
    const second = (await member.get('/api/requests?page=2')).json();
    expect(second.results.map((r: { tmdbId: number }) => r.tmdbId)).toEqual([1004, 1003, 1002, 1001, 1000]);

    const all = (await owner.get('/api/requests')).json();
    expect(all.results).toHaveLength(20);
    expect((await owner.get('/api/requests?status=declined')).json().results).toMatchObject([{ tmdbId: 5000 }]);
    expect((await owner.get('/api/requests?mine=true')).json()).toMatchObject({ page: 1, totalPages: 0, results: [] });
    expect((await owner.get('/api/requests?status=perdu')).statusCode).toBe(400);
  });

  it('filtres : plusieurs statuts séparés par des virgules, un titre (type + tmdbId) ; totaux par statut du périmètre', async () => {
    const { as, db } = await setup();
    const member = await as('member', 'a');
    const other = await as('member', 'b');
    const manager = await as('manager', 'c');
    seedRequest(db, { userId: member.user.id, tmdbId: 1, createdAt: new Date(Date.now() - 3000) });
    seedRequest(db, { userId: member.user.id, tmdbId: 2, status: 'failed', createdAt: new Date(Date.now() - 2000) });
    seedRequest(db, { userId: member.user.id, tmdbId: 3, status: 'declined', createdAt: new Date(Date.now() - 1000) });
    seedRequest(db, { userId: member.user.id, tmdbId: 1, type: 'tv', status: 'sent', seasons: [1] });
    seedRequest(db, { userId: other.user.id, tmdbId: 4 });

    const keys = (page: RequestPage) => page.results.map((r) => `${r.type}:${r.tmdbId}`);
    const several = (await member.get('/api/requests?status=pending,failed')).json<RequestPage>();
    expect(keys(several)).toEqual(['movie:2', 'movie:1']);
    expect(several.totalPages).toBe(1);
    // Totaux du périmètre (ses demandes), indépendants du filtre de statut.
    expect(several.totals).toEqual({
      pending: 1,
      approved: 0,
      declined: 1,
      cancelled: 0,
      sent: 1,
      failed: 1,
      available: 0,
    });
    // Approbateur : toutes les demandes.
    const all = (await manager.get('/api/requests?status=pending')).json<RequestPage>();
    expect(keys(all)).toEqual(['movie:4', 'movie:1']);
    expect(all.totals).toMatchObject({ pending: 2, failed: 1, sent: 1, declined: 1 });

    // Un titre : le film 1 et la série 1 sont deux titres distincts.
    const movie = (await member.get('/api/requests?mine=true&type=movie&tmdbId=1')).json<RequestPage>();
    expect(keys(movie)).toEqual(['movie:1']);
    expect(movie.totals).toMatchObject({ pending: 1, sent: 0 });
    const series = (await member.get('/api/requests?type=tv&tmdbId=1')).json<RequestPage>();
    expect(keys(series)).toEqual(['tv:1']);
    expect(series.results[0]?.seasons).toEqual([1]);
    expect(keys((await member.get('/api/requests?type=tv')).json<RequestPage>())).toEqual(['tv:1']);

    expect((await member.get('/api/requests?status=pending,pending')).json<RequestPage>().totalPages).toBe(
      (await member.get('/api/requests?status=pending')).json<RequestPage>().totalPages,
    );
    for (const query of ['status=pending&status=failed', 'status=', 'status=pending,', 'tmdbId=1', 'type=livre'])
      expect((await member.get(`/api/requests?${query}`)).statusCode, query).toBe(400);
  });

  it('raison du dernier échec dans chaque ligne de la liste, effacée par une relance réussie', async () => {
    const { as } = await setup({
      radarr: radarrRoutes({
        'POST /api/v3/movie': sequence(status(500), status(503), status(201, { id: 42 })),
      }),
    });
    const member = await as('member');
    const owner = await as('owner', 'proprietaire');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    const first = (await owner.post(`/api/requests/${id}/approve`)).json<RequestDetail>();
    expect(first.failureReason).toBe('Radarr a répondu par une erreur (500)');
    await owner.post(`/api/requests/${id}/retry`);

    const failed = (await owner.get('/api/requests?status=failed')).json<RequestPage>();
    const lastReason = (await owner.get(`/api/requests/${id}`)).json<RequestDetail>().events.at(-1)?.detail;
    expect(lastReason).not.toBe(first.failureReason);
    expect(failed.results).toMatchObject([{ id, failureReason: lastReason }]);

    await owner.post(`/api/requests/${id}/retry`);
    expect((await owner.get('/api/requests')).json<RequestPage>().results).toMatchObject([
      { id, status: 'sent', failureReason: null },
    ]);
  });

  it('les requêtes de la liste passent par les index (pas de parcours de toute la table)', () => {
    const db = openDb(':memory:');
    const scopes = [{ userId: 'u' }, {}, { userId: 'u', title: { type: 'movie' as const, tmdbId: 1 } }];
    for (const scope of scopes) {
      const totals = queryPlan(db, requestTotalsQuery(db, scope));
      const page = queryPlan(db, requestPageQuery(db, scope, ['pending', 'failed'], 1));
      for (const plan of [totals, page]) expect(plan).not.toMatch(/SCAN requests(?! USING COVERING INDEX)/);
    }
    expect(queryPlan(db, requestTotalsQuery(db, {}))).toContain('USING COVERING INDEX requests_status_created_at_idx');
    expect(queryPlan(db, requestTotalsQuery(db, { userId: 'u' }))).toContain('requests_user_id_created_at_idx');
    expect(queryPlan(db, requestPageQuery(db, {}, ['pending', 'failed'], 1))).toContain(
      'requests_status_created_at_idx',
    );
    expect(queryPlan(db, requestTotalsQuery(db, { title: { type: 'tv', tmdbId: 1 } }))).toContain(
      'media_type_tmdb_id_unique',
    );
    expect(queryPlan(db, lastFailureQuery(db, [1, 2]))).toContain('request_events_request_id_created_at_idx');
  });

  it('GET /api/requests/:id : frise, demandeur et résumé ; invisible pour un autre membre', async () => {
    const { as } = await setup();
    const member = await as('member', 'a');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

    const res = await member.get(`/api/requests/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      requester: { id: member.user.id, name: 'Nom a' },
      media: { title: 'Matrix' },
      events: [{ type: 'requested', actor: { id: member.user.id } }],
    });
    expect((await (await as('member', 'b')).get(`/api/requests/${id}`)).statusCode).toBe(404);
    expect((await (await as('manager', 'c')).get(`/api/requests/${id}`)).statusCode).toBe(200);
    expect((await member.get('/api/requests/abc')).statusCode).toBe(400);
  });

  it('GET /api/requests/counts : file d’approbation (approbateurs seulement) et demandes en cours du membre', async () => {
    const { as, db } = await setup();
    const member = await as('member', 'a');
    const owner = await as('owner', 'proprietaire');
    seedRequest(db, { userId: member.user.id, tmdbId: 1 });
    seedRequest(db, { userId: member.user.id, tmdbId: 2, status: 'sent' });
    seedRequest(db, { userId: member.user.id, tmdbId: 3, status: 'declined' });

    expect((await member.get('/api/requests/counts')).json()).toEqual({ pendingApprovals: null, mineActive: 2 });
    expect((await owner.get('/api/requests/counts')).json()).toEqual({ pendingApprovals: 1, mineActive: 0 });
  });
});

// --- Statut affiché ---

describe('statut affiché des titres', () => {
  it('une demande se voit de tous : en attente, puis Demandé, Refusé', async () => {
    const { as } = await setup();
    const member = await as('member', 'a');
    const viewer = await as('member', 'b');
    const owner = await as('owner', 'proprietaire');
    const statusOf = async () => (await viewer.get('/api/media/movie/603')).json().status;

    expect(await statusOf()).toBeUndefined();
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    expect(await statusOf()).toBe('pending');
    await owner.post(`/api/requests/${id}/decline`, { reason: 'Non' });
    expect(await statusOf()).toBe('declined');
    const again = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    await owner.post(`/api/requests/${again.id}/approve`);
    expect(await statusOf()).toBe('requested');
  });

  it('fiche d’une série : chaque saison demandée porte son statut', async () => {
    const { as } = await setup({ sonarr: sonarrRoutes({ 'GET /api/v3/series': sonarrSeries([[1, 7, 7]]) }) });
    const member = await as('member');
    await member.post('/api/requests', { type: 'tv', tmdbId: 1396, seasons: [2] });
    const fiche = (await member.get('/api/media/tv/1396')).json();
    expect(fiche.seasons.map((s: { seasonNumber: number; status?: string }) => [s.seasonNumber, s.status])).toEqual([
      [0, undefined],
      [1, 'available'],
      [2, 'pending'],
      [3, undefined],
    ]);
    // « Partiel » côté bibliothèque, une demande en cours l'emporte.
    expect(fiche.status).toBe('pending');
  });

  it('lecture par lot : « Demandé » > « En attente » > « Refusé », même sans service de bibliothèque', () => {
    const db = openDb(':memory:');
    for (const id of ['a', 'b', 'c']) upsertFromEmby(db, { id, name: id, avatar: null, isEmbyAdmin: false });
    seedRequest(db, { userId: 'a', tmdbId: 1, status: 'declined' });
    seedRequest(db, { userId: 'b', tmdbId: 1, status: 'pending' });
    seedRequest(db, { userId: 'a', tmdbId: 2, status: 'pending' });
    seedRequest(db, { userId: 'b', tmdbId: 2, status: 'failed' });
    seedRequest(db, { userId: 'c', tmdbId: 3, status: 'cancelled' });
    seedRequest(db, { userId: 'c', tmdbId: 4, status: 'declined' });

    const keys = [1, 2, 3, 4, 5].map((tmdbId) => ({ type: 'movie' as const, tmdbId }));
    expect(Object.fromEntries(requestStatesFor(db, keys))).toEqual({
      'movie:1': { status: 'pending' },
      'movie:2': { status: 'requested' },
      'movie:4': { status: 'declined' },
    });
    db.$client.close();
  });
});

// --- Base ---

describe('tables des demandes', () => {
  it('requests_active : une seule demande en cours par membre et par titre ; `ON CONFLICT` reprend l’index partiel', () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, { id: 'a', name: 'a', avatar: null, isEmbyAdmin: false });
    const first = seedRequest(db, { userId: 'a', tmdbId: 1 });
    const insert = () =>
      db
        .insert(requests)
        .values({ mediaId: first.mediaId, userId: 'a', status: 'pending' })
        .onConflictDoUpdate(ACTIVE_CONFLICT)
        .run();

    expect(insert().changes).toBe(0);
    expect(() => db.insert(requests).values({ mediaId: first.mediaId, userId: 'a', status: 'approved' }).run()).toThrow(
      /UNIQUE constraint failed/,
    );
    // Refusée ou annulée : hors de l'index, une nouvelle demande est possible.
    db.update(requests).set({ status: 'declined' }).where(eq(requests.id, first.id)).run();
    expect(insert().changes).toBe(1);
    // Envoyée : hors de l'index aussi, elle ne bloque pas une nouvelle demande (saisons suivantes d'une série).
    db.update(requests).set({ status: 'sent' }).where(eq(requests.status, 'pending')).run();
    expect(insert().changes).toBe(1);
    db.$client.close();
  });

  it('refuse un statut ou un type d’évènement inconnu', () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, { id: 'a', name: 'a', avatar: null, isEmbyAdmin: false });
    const { id, mediaId } = seedRequest(db, { userId: 'a', tmdbId: 1 });
    expect(() =>
      db.$client.prepare("insert into requests (media_id, user_id, status) values (?, 'a', 'perdu')").run(mediaId),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.$client.prepare("insert into request_events (request_id, type) values (?, 'perdu')").run(id),
    ).toThrow(/CHECK constraint failed/);
    db.$client.close();
  });
});
