import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir } from '../src/server/db/index.ts';
import { requestSeasons, requests, users, watchlist } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { setQuotaOverride } from '../src/server/services/users.ts';
import type { PermissionOverrides, Role } from '../src/shared/roles.ts';
import {
  type AddedToWatchlist,
  type AutoRequestSetting,
  addedMessage,
  WATCHLIST_AUTO_REQUEST_PATH,
  WATCHLIST_PATH,
} from '../src/shared/watchlist.ts';
import { type FakeRoutes, startFakeServer } from './fake-server.ts';
import { addArrServer, loginAs, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const matrix = { id: 603, title: 'Matrix', release_date: '1999-03-30', poster_path: '/matrix.jpg' };
/** Saisons : 0 (spéciaux), 1 et 2 diffusées, 3 annoncée. */
const breakingBad = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  seasons: [
    { season_number: 0, episode_count: 9, air_date: null },
    { season_number: 1, episode_count: 7, air_date: '2008-01-20' },
    { season_number: 2, episode_count: 13, air_date: '2009-03-08' },
    { season_number: 3, episode_count: 10, air_date: '2099-01-01' },
  ],
  external_ids: { imdb_id: '', tvdb_id: 81189 },
};

const emptyQueue = { totalRecords: 0, records: [] };
const radarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/movie': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  'GET /api/v3/qualityprofile': [{ id: 1, name: 'HD-1080p' }],
  'GET /api/v3/rootfolder': [{ id: 1, path: '/films', freeSpace: 1000 }],
  ...overrides,
});
const sonarrRoutes = (): FakeRoutes => ({
  'GET /api/v3/series': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/qualityprofile': [{ id: 2, name: 'HD-720p' }],
  'GET /api/v3/rootfolder': [{ id: 1, path: '/series', freeSpace: 1000 }],
});

async function setup(arr: { radarr?: FakeRoutes } = {}) {
  const tmdb = await startFakeServer({ 'GET /movie/603': matrix, 'GET /tv/1396': breakingBad });
  const radarr = await startFakeServer(arr.radarr ?? radarrRoutes());
  const sonarr = await startFakeServer(sonarrRoutes());
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  addArrServer(data, { type: 'radarr', url: radarr.url, rootFolderPath: '/films' });
  addArrServer(data, { type: 'sonarr', url: sonarr.url, qualityProfileId: 2, rootFolderPath: '/series' });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url } });
  cleanups.push(() => app.close(), tmdb.close, radarr.close, sonarr.close);

  /** Membre connecté ; `rights` : remplacements de droits ; `autoRequest` : l'option est déjà activée en base. */
  const member = async ({
    role = 'member',
    id = 'alice',
    rights = { canAutoRequestWatchlist: true },
    autoRequest = true,
  }: {
    role?: Role;
    id?: string;
    rights?: PermissionOverrides;
    autoRequest?: boolean;
  } = {}) => {
    const { user, headers } = await loginAs(app, role, id);
    data.db
      .update(users)
      .set({ permissions: rights, watchlistAutoRequest: autoRequest })
      .where(eq(users.id, user.id))
      .run();
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload && { payload }) });
    return {
      user,
      call,
      add: async (type: 'movie' | 'tv', tmdbId: number) => {
        const res = await call('POST', WATCHLIST_PATH, { type, tmdbId });
        expect(res.statusCode).toBe(200);
        return res.json<AddedToWatchlist>();
      },
    };
  };
  return { app, db: data.db, radarr, member };
}

const requestRows = (db: Db) => db.select().from(requests).all();
const seasonsOf = (db: Db) =>
  db
    .select({ n: requestSeasons.seasonNumber })
    .from(requestSeasons)
    .all()
    .map((s) => s.n)
    .sort();

describe('option « demander automatiquement » (droit canAutoRequestWatchlist)', () => {
  it('refuse la lecture et l’écriture sans le droit (403), l’option reste inchangée', async () => {
    const { member, db } = await setup();
    const alice = await member({ rights: {}, autoRequest: false });
    expect((await alice.call('GET', WATCHLIST_AUTO_REQUEST_PATH)).statusCode).toBe(403);
    expect((await alice.call('PUT', WATCHLIST_AUTO_REQUEST_PATH, { enabled: true })).statusCode).toBe(403);
    expect(db.select().from(users).where(eq(users.id, alice.user.id)).get()?.watchlistAutoRequest).toBe(false);
  });

  it('exige une session', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: WATCHLIST_AUTO_REQUEST_PATH })).statusCode).toBe(401);
  });

  it('se lit et s’écrit avec le droit, accordé à un membre ou préréglé du propriétaire', async () => {
    const { member } = await setup();
    const alice = await member({ autoRequest: false });
    expect((await alice.call('GET', WATCHLIST_AUTO_REQUEST_PATH)).json<AutoRequestSetting>()).toEqual({
      enabled: false,
    });
    const put = await alice.call('PUT', WATCHLIST_AUTO_REQUEST_PATH, { enabled: true });
    expect(put.json()).toEqual({ enabled: true });
    expect((await alice.call('GET', WATCHLIST_AUTO_REQUEST_PATH)).json()).toEqual({ enabled: true });
    expect((await alice.call('PUT', WATCHLIST_AUTO_REQUEST_PATH, { enabled: 'oui' })).statusCode).toBe(400);

    const boss = await member({ role: 'owner', id: 'proprio', rights: {}, autoRequest: false });
    expect((await boss.call('PUT', WATCHLIST_AUTO_REQUEST_PATH, { enabled: true })).json()).toEqual({ enabled: true });
  });
});

describe('ajout à Ma liste avec l’option', () => {
  it('film : ajouté à la liste et demandé en qualité normale, demande ordinaire du membre', async () => {
    const { member, db } = await setup();
    const alice = await member();
    expect(await alice.add('movie', 603)).toEqual({ inList: true, autoRequest: { status: 'requested' } });

    expect(db.select().from(watchlist).all()).toHaveLength(1);
    expect(requestRows(db)).toMatchObject([{ userId: alice.user.id, status: 'pending', is4k: false, createdBy: null }]);
  });

  it('série : toutes les saisons diffusées, sans les spéciales ni l’annoncée', async () => {
    const { member, db } = await setup();
    const alice = await member();
    expect((await alice.add('tv', 1396)).autoRequest).toEqual({ status: 'requested' });
    expect(seasonsOf(db)).toEqual([1, 2]);
  });

  it('sans l’option : rien n’est demandé, et la réponse ne parle pas de demande', async () => {
    const { member, db } = await setup();
    const alice = await member({ autoRequest: false });
    expect(await alice.add('movie', 603)).toEqual({ inList: true });
    expect(requestRows(db)).toEqual([]);
  });

  it('option ignorée si le droit est retiré, reprise s’il revient', async () => {
    const { member, db } = await setup();
    const alice = await member({ rights: { canAutoRequestWatchlist: false }, autoRequest: true });
    expect(await alice.add('movie', 603)).toEqual({ inList: true });
    expect(requestRows(db)).toEqual([]);

    db.update(users)
      .set({ permissions: { canAutoRequestWatchlist: true } })
      .where(eq(users.id, alice.user.id))
      .run();
    expect((await alice.add('tv', 1396)).autoRequest).toEqual({ status: 'requested' });
  });

  it('quota atteint : l’ajout réussit, la demande est sautée avec son motif', async () => {
    const { member, db } = await setup();
    const alice = await member();
    setQuotaOverride(db, alice.user.id, { movies: { limit: 0, days: 7 }, seasons: null });
    const added = await alice.add('movie', 603);

    expect(added).toEqual({
      inList: true,
      autoRequest: { status: 'skipped', reason: 'Quota atteint : 0 film sur 7 jours' },
    });
    expect(db.select().from(watchlist).all()).toHaveLength(1);
    expect(requestRows(db)).toEqual([]);
  });

  it('titre déjà disponible : sauté', async () => {
    const { member, db } = await setup({
      radarr: radarrRoutes({ 'GET /api/v3/movie': [{ id: 42, tmdbId: 603, hasFile: true, monitored: true }] }),
    });
    const alice = await member();
    expect((await alice.add('movie', 603)).autoRequest).toEqual({
      status: 'skipped',
      reason: 'Ce titre est déjà disponible dans le serveur multimédia',
    });
    expect(requestRows(db)).toEqual([]);
  });

  it('titre déjà demandé (par soi ou par un autre) : sauté, sans doublon', async () => {
    const { member, db } = await setup();
    const alice = await member();
    const bob = await member({ id: 'bob' });
    expect((await alice.add('movie', 603)).autoRequest).toEqual({ status: 'requested' });

    expect((await alice.add('movie', 603)).autoRequest).toMatchObject({ status: 'skipped' });
    expect((await bob.add('movie', 603)).autoRequest).toEqual({
      status: 'skipped',
      reason: 'Ce titre est déjà demandé',
    });
    expect(requestRows(db)).toHaveLength(1);
  });

  it('série : les saisons manquantes sont fusionnées dans sa demande en attente, signalées comme demandées', async () => {
    const { member, db } = await setup();
    const alice = await member();
    const res = await alice.call('POST', '/api/requests', { type: 'tv', tmdbId: 1396, seasons: [1] });
    expect(res.statusCode).toBe(201);

    expect((await alice.add('tv', 1396)).autoRequest).toEqual({ status: 'requested' });
    expect(requestRows(db)).toHaveLength(1);
    expect(seasonsOf(db)).toEqual([1, 2]);
    expect((await alice.add('tv', 1396)).autoRequest).toMatchObject({ status: 'skipped' });
  });

  it('droit de demander retiré : l’ajout réussit, la demande est refusée avec son motif', async () => {
    const { member, db } = await setup();
    const alice = await member({ rights: { canAutoRequestWatchlist: true, canRequestMovies: false } });
    const added = await alice.add('movie', 603);
    expect(added.inList).toBe(true);
    expect(added.autoRequest?.status).toBe('skipped');
    expect(requestRows(db)).toEqual([]);
  });

  it('approbation automatique selon les droits du membre : la demande part à Radarr', async () => {
    const { member, db, radarr } = await setup();
    const alice = await member({ role: 'auto_approve' });
    expect((await alice.add('movie', 603)).autoRequest).toEqual({ status: 'requested' });

    expect(requestRows(db)).toMatchObject([{ userId: alice.user.id, status: 'sent' }]);
    expect(radarr.requests.filter((r) => r.method === 'POST' && r.path === '/api/v3/movie')).toHaveLength(1);
  });

  it('sans approbation automatique : la demande attend un gestionnaire', async () => {
    const { member, db, radarr } = await setup();
    await (await member()).add('movie', 603);
    expect(requestRows(db)).toMatchObject([{ status: 'pending' }]);
    expect(radarr.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('message après l’ajout', () => {
  it('ne dit rien sans option, annonce la demande, ou le motif en minuscule', () => {
    expect(addedMessage(undefined)).toBeNull();
    expect(addedMessage({ status: 'requested' })).toBe('Ajouté à Ma liste et demandé.');
    expect(addedMessage({ status: 'skipped', reason: 'Quota atteint : 1 film sur 7 jours' })).toBe(
      'Ajouté à Ma liste ; pas demandé : quota atteint : 1 film sur 7 jours',
    );
    expect(addedMessage({ status: 'skipped', reason: 'TMDB ne répond pas' })).toBe(
      'Ajouté à Ma liste ; pas demandé : TMDB ne répond pas',
    );
  });
});
