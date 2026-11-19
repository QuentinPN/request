import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { requestSeasons, requests, users } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { setQuotaOverride } from '../src/server/services/users.ts';
import { type RequestDetail, resolveSendChoice } from '../src/shared/requests.ts';
import type { PermissionOverrides, Role } from '../src/shared/roles.ts';
import type { FakeHandler, FakeRoutes } from './fake-server.ts';
import { addArrServer, loginAs, trackFakeServers, trackTempDirs } from './helpers.ts';

// Lot 8.8b : demande avancée (serveur, profil, dossier, type de série) et modification d'une demande en attente.

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const matrix = { id: 603, title: 'Matrix', release_date: '1999-03-30', overview: 'Un pirate.' };
/** Trois saisons diffusées. */
const got = {
  id: 1399,
  name: 'Game of Thrones',
  first_air_date: '2011-04-17',
  overview: 'Trônes.',
  seasons: [1, 2, 3].map((n) => ({ season_number: n, episode_count: 10, air_date: `${2010 + n}-04-17` })),
  external_ids: { tvdb_id: 121361 },
};

const emptyQueue = { totalRecords: 0, records: [] };
const profiles = [
  { id: 1, name: 'HD-1080p' },
  { id: 2, name: 'HD-720p' },
];
const folders = (main: string) => [
  { id: 1, path: main, freeSpace: 1000 },
  { id: 2, path: '/anime', freeSpace: 2000 },
];
const radarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/movie': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  'GET /api/v3/qualityprofile': profiles,
  'GET /api/v3/rootfolder': folders('/films'),
  ...overrides,
});
const sonarrRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /api/v3/series': [],
  'GET /api/v3/queue': emptyQueue,
  'GET /api/v3/series/lookup': [
    { id: 0, title: 'GoT', tvdbId: 121361, seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber })) },
  ],
  'POST /api/v3/series': { id: 7, monitored: true, seasons: [] },
  'GET /api/v3/qualityprofile': profiles,
  'GET /api/v3/rootfolder': folders('/series'),
  ...overrides,
});

interface Actor {
  user: { id: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
  patch: (url: string, payload: object) => Promise<LightMyRequestResponse>;
}

/** Appli sur un faux TMDB, deux Radarr (« Radarr », « Radarr bis »), un Radarr 4K et un Sonarr. */
async function setup({ radarr = radarrRoutes(), sonarr = sonarrRoutes() } = {}) {
  const servers = {
    tmdb: await startServer({ 'GET /movie/603': matrix, 'GET /tv/1399': got }),
    radarr: await startServer(radarr),
    radarrBis: await startServer(radarrRoutes({ 'GET /api/v3/rootfolder': folders('/bis') })),
    radarr4k: await startServer(radarrRoutes({ 'GET /api/v3/rootfolder': folders('/4k') })),
    sonarr: await startServer(sonarr),
  };
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const ids = {
    radarr: addArrServer(data, { type: 'radarr', url: servers.radarr.url, rootFolderPath: '/films' }).id,
    radarrBis: addArrServer(data, {
      type: 'radarr',
      name: 'Radarr bis',
      url: servers.radarrBis.url,
      rootFolderPath: '/bis',
    }).id,
    radarr4k: addArrServer(data, { type: 'radarr', is4k: true, url: servers.radarr4k.url, rootFolderPath: '/4k' }).id,
    sonarr: addArrServer(data, { type: 'sonarr', url: servers.sonarr.url, rootFolderPath: '/series' }).id,
  };
  const app = await buildApp({ data, upstreams: { tmdbUrl: servers.tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string, permissions: PermissionOverrides | null = null): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    if (permissions) db.update(users).set({ permissions }).where(eq(users.id, user.id)).run();
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
      patch: (url, payload) => app.inject({ method: 'PATCH', url, headers, payload }),
    };
  };
  return { app, db, servers, ids, as };
}

const posted = (server: { requests: Array<{ method: string; path: string; body: unknown }> }, path: string) =>
  server.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body as Record<string, unknown>);

const ADVANCED = { canAdvancedRequest: true };
const seasonsOf = (db: Awaited<ReturnType<typeof setup>>['db'], id: number) =>
  db
    .select({ n: requestSeasons.seasonNumber })
    .from(requestSeasons)
    .where(eq(requestSeasons.requestId, id))
    .all()
    .map((s) => s.n)
    .sort();

describe('ordre de priorité des choix d’envoi (resolveSendChoice)', () => {
  it('approbateur, puis choix enregistré, puis valeurs du serveur ; un choix d’un autre serveur ne vaut pas', () => {
    const stored = { serverId: 2, qualityProfileId: 7, rootFolderPath: '/a', seriesType: 'anime' as const };
    const defaults = { qualityProfileId: 1, rootFolderPath: '/defaut', seriesType: 'standard' as const };
    expect(resolveSendChoice([{}, stored, defaults], 1)).toEqual(stored);
    expect(resolveSendChoice([{ qualityProfileId: 9 }, stored, defaults], 1)).toEqual({
      ...stored,
      qualityProfileId: 9,
    });
    // L'approbateur change de serveur : profil, dossier et type enregistrés pour le serveur 2 n'y existent pas.
    expect(resolveSendChoice([{ serverId: 3 }, stored, defaults], 1)).toEqual({ serverId: 3, ...defaults });
    expect(resolveSendChoice([{}, { serverId: null, qualityProfileId: null }, defaults], 1)).toEqual({
      serverId: 1,
      ...defaults,
    });
  });
});

describe('demande avancée', () => {
  it('sans le droit « Demande avancée » : 403 à la création et sur les listes d’envoi', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    const res = await member.post('/api/requests', { type: 'movie', tmdbId: 603, qualityProfileId: 2 });
    expect(res.statusCode).toBe(403);
    expect(db.select().from(requests).all()).toHaveLength(0);
    expect((await member.get('/api/requests/send-options/movie')).statusCode).toBe(403);
    const advanced = await as('member', 'avance', ADVANCED);
    expect((await advanced.get('/api/requests/send-options/movie')).statusCode).toBe(200);
  });

  it('valide le serveur (type, 4K), le profil et le dossier, puis enregistre le choix sur la demande', async () => {
    const { as, ids } = await setup();
    const member = await as('member', 'avance', ADVANCED);
    const movie = { type: 'movie', tmdbId: 603 } as const;
    const refused = [
      [{ serverId: ids.sonarr }, 'Serveur inconnu parmi les serveurs Radarr'],
      [{ serverId: ids.radarr4k }, 'Serveur inconnu parmi les serveurs Radarr'],
      [{ qualityProfileId: 99 }, 'Profil de qualité inconnu de Radarr'],
      [{ serverId: ids.radarrBis, rootFolderPath: '/films' }, 'Dossier racine inconnu de Radarr bis'],
    ] as const;
    for (const [choice, error] of refused) {
      const res = await member.post('/api/requests', { ...movie, ...choice });
      expect(res.statusCode, JSON.stringify(choice)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    const fourK = await member.post('/api/requests', { ...movie, is4k: true, serverId: ids.radarr });
    expect(fourK.json()).toEqual({ error: 'Serveur inconnu parmi les serveurs Radarr 4K' });
    const res = await member.post('/api/requests', { ...movie, serverId: ids.radarrBis, rootFolderPath: '/anime' });
    expect(res.statusCode).toBe(201);
    expect(res.json<RequestDetail>()).toMatchObject({
      status: 'pending',
      server: { id: ids.radarrBis, name: 'Radarr bis' },
      qualityProfileId: null,
      rootFolder: '/anime',
    });
  });

  it('approbation : choix du gestionnaire, puis choix enregistré, puis valeurs du serveur', async () => {
    const { as, servers, ids } = await setup();
    const member = await as('member', 'avance', ADVANCED);
    const owner = await as('owner', 'proprietaire');
    const create = async (choice: object) =>
      (await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [1], ...choice })).json<RequestDetail>();

    // Choix enregistré seul : envoyé tel quel.
    const stored = await create({ qualityProfileId: 2, rootFolderPath: '/anime', seriesType: 'anime' });
    expect(stored).toMatchObject({ server: { id: ids.sonarr }, qualityProfileId: 2, seriesType: 'anime' });
    const sent = (await owner.post(`/api/requests/${stored.id}/approve`, {})).json<RequestDetail>();
    expect(sent).toMatchObject({ status: 'sent', qualityProfileId: 2, rootFolder: '/anime', seriesType: 'anime' });
    expect(posted(servers.sonarr, '/api/v3/series')[0]).toMatchObject({
      qualityProfileId: 2,
      rootFolderPath: '/anime',
      seriesType: 'anime',
    });
  });

  it('approbation : le gestionnaire l’emporte champ par champ', async () => {
    const { as, servers } = await setup();
    const member = await as('member', 'avance', ADVANCED);
    const owner = await as('owner', 'proprietaire');
    const { id } = (
      await member.post('/api/requests', { type: 'movie', tmdbId: 603, qualityProfileId: 2, rootFolderPath: '/anime' })
    ).json<RequestDetail>();
    const res = await owner.post(`/api/requests/${id}/approve`, { qualityProfileId: 1 });
    expect(res.json<RequestDetail>()).toMatchObject({ status: 'sent', qualityProfileId: 1, rootFolder: '/anime' });
    expect(posted(servers.radarr, '/api/v3/movie')[0]).toMatchObject({ qualityProfileId: 1, rootFolderPath: '/anime' });
  });

  it('approbation sur un autre serveur : le choix enregistré (autre serveur) est écarté', async () => {
    const { as, servers, ids } = await setup();
    const member = await as('member', 'avance', ADVANCED);
    const owner = await as('owner', 'proprietaire');
    const { id } = (
      await member.post('/api/requests', {
        type: 'movie',
        tmdbId: 603,
        serverId: ids.radarrBis,
        qualityProfileId: 2,
        rootFolderPath: '/anime',
      })
    ).json<RequestDetail>();
    const res = await owner.post(`/api/requests/${id}/approve`, { serverId: ids.radarr });
    expect(res.json<RequestDetail>()).toMatchObject({
      status: 'sent',
      server: { id: ids.radarr },
      qualityProfileId: 1,
      rootFolder: '/films',
    });
    expect(posted(servers.radarrBis, '/api/v3/movie')).toHaveLength(0);
  });

  it('approbation automatique : le choix de la demande est envoyé directement', async () => {
    const { as, servers, ids } = await setup();
    const member = await as('auto_approve', 'auto', ADVANCED);
    const res = await member.post('/api/requests', {
      type: 'movie',
      tmdbId: 603,
      serverId: ids.radarrBis,
      rootFolderPath: '/anime',
    });
    expect(res.json<RequestDetail>()).toMatchObject({ status: 'sent', server: { id: ids.radarrBis } });
    expect(posted(servers.radarrBis, '/api/v3/movie')[0]).toMatchObject({
      qualityProfileId: 1,
      rootFolderPath: '/anime',
    });
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(0);
  });
});

describe('PATCH /api/requests/:id : modifier une demande en attente', () => {
  const askGot = (actor: Actor, seasons = [1]) =>
    actor.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons }).then((r) => r.json<RequestDetail>());

  it('droits : le demandeur (options avancées avec le droit), un gestionnaire ; sinon 403 ou 404', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    const { id } = await askGot(member);
    const stranger = await as('member', 'autre');
    expect((await stranger.patch(`/api/requests/${id}`, { seasons: [1, 2] })).statusCode).toBe(404);
    expect((await member.patch(`/api/requests/${id}`, { qualityProfileId: 2 })).statusCode).toBe(403);
    const mine = await member.patch(`/api/requests/${id}`, { seasons: [1, 2] });
    expect(mine.statusCode).toBe(200);
    expect(mine.json<RequestDetail>()).toMatchObject({ status: 'pending', seasons: [1, 2] });

    const manager = await as('manager', 'gestionnaire');
    const res = await manager.patch(`/api/requests/${id}`, { seasons: [2], qualityProfileId: 2 });
    expect(res.statusCode).toBe(200);
    const detail = res.json<RequestDetail>();
    expect(detail).toMatchObject({ seasons: [2], qualityProfileId: 2, rootFolder: null });
    expect(detail.events.at(-1)).toMatchObject({
      type: 'requested',
      actor: { id: manager.user.id },
      detail: 'Demande modifiée : saisons retirées 1 ; options d’envoi',
    });
    expect(seasonsOf(db, id)).toEqual([2]);
  });

  it('entrées invalides : aucune saison (annuler à la place), film avec saisons, saison inconnue, autre type', async () => {
    const { as, ids } = await setup();
    const manager = await as('manager', 'gestionnaire');
    const member = await as('member');
    const { id } = await askGot(member);
    expect((await member.patch(`/api/requests/${id}`, { seasons: [] })).statusCode).toBe(400);
    expect((await member.patch(`/api/requests/${id}`, {})).statusCode).toBe(400);
    expect((await member.patch(`/api/requests/${id}`, { seasons: [1, 9] })).json()).toEqual({
      error: 'Saison inconnue',
    });
    expect((await manager.patch(`/api/requests/${id}`, { serverId: ids.radarr })).statusCode).toBe(400);
    const movie = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    expect((await member.patch(`/api/requests/${movie.id}`, { seasons: [1] })).statusCode).toBe(400);
  });

  it('choix d’envoi renvoyé tel qu’enregistré : la frise ne note que les saisons', async () => {
    const { as } = await setup();
    const member = await as('member', 'avance', ADVANCED);
    const choice = { qualityProfileId: 2, rootFolderPath: '/anime', seriesType: 'anime' };
    const { id, server } = (
      await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [1], ...choice })
    ).json<RequestDetail>();
    const res = await member.patch(`/api/requests/${id}`, { seasons: [1, 2], serverId: server?.id, ...choice });
    expect(res.json<RequestDetail>().events.at(-1)?.detail).toBe('Demande modifiée : saisons ajoutées 2');
    const same = await member.patch(`/api/requests/${id}`, { seasons: [1, 2], serverId: server?.id, ...choice });
    expect(same.json<RequestDetail>().events).toHaveLength(2);
  });

  it('409 si la demande n’est plus en attente', async () => {
    const { as } = await setup();
    const member = await as('member');
    const { id } = await askGot(member);
    await (await as('owner', 'proprietaire')).post(`/api/requests/${id}/approve`, {});
    const res = await member.patch(`/api/requests/${id}`, { seasons: [1, 2] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Cette demande n’est plus en attente' });
  });

  it('approbation concurrente pendant la modification : 409, rien n’est écrit', async () => {
    let approveNow: (() => void) | undefined;
    // L'approbation passe entre la validation (lecture des profils chez Sonarr) et l'écriture.
    const profilesThenApprove: FakeHandler = (_req, res) => {
      approveNow?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(profiles));
    };
    const { as, db } = await setup({ sonarr: sonarrRoutes({ 'GET /api/v3/qualityprofile': profilesThenApprove }) });
    const member = await as('member', 'avance', ADVANCED);
    const { id } = await askGot(member);
    approveNow = () => db.update(requests).set({ status: 'approved' }).where(eq(requests.id, id)).run();
    const res = await member.patch(`/api/requests/${id}`, { seasons: [1, 2], qualityProfileId: 2 });
    expect(res.statusCode).toBe(409);
    expect(seasonsOf(db, id)).toEqual([1]);
    expect(db.select().from(requests).where(eq(requests.id, id)).get()).toMatchObject({ qualityProfileId: null });
  });

  it('modification pendant l’approbation : 409, l’approbation ne repose pas sur un choix périmé', async () => {
    let editNow: (() => void) | undefined;
    // Le PATCH passe pendant que l'approbation vérifie le profil chez Radarr.
    const profilesThenEdit: FakeHandler = (_req, res) => {
      editNow?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(profiles));
    };
    const { as, db, servers } = await setup({
      radarr: radarrRoutes({ 'GET /api/v3/qualityprofile': profilesThenEdit }),
    });
    const member = await as('member', 'avance', ADVANCED);
    const { id } = (
      await member.post('/api/requests', { type: 'movie', tmdbId: 603, rootFolderPath: '/films' })
    ).json<RequestDetail>();
    editNow = () => db.update(requests).set({ rootFolder: '/anime' }).where(eq(requests.id, id)).run();
    const res = await (await as('owner', 'proprietaire')).post(`/api/requests/${id}/approve`, { qualityProfileId: 2 });
    expect(res.statusCode).toBe(409);
    expect(db.select().from(requests).where(eq(requests.id, id)).get()).toMatchObject({ status: 'pending' });
    expect(posted(servers.radarr, '/api/v3/movie')).toHaveLength(0);
  });

  /** Appli dont le Sonarr exécute `hook.run` à la lecture des profils (entre la validation et l'écriture). */
  async function setupWithSonarrHook() {
    const hook: { run?: () => void } = {};
    const profilesThenRun: FakeHandler = (_req, res) => {
      hook.run?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(profiles));
    };
    return { hook, ...(await setup({ sonarr: sonarrRoutes({ 'GET /api/v3/qualityprofile': profilesThenRun }) })) };
  }

  it('modifications concurrentes : saisons relues dans la transaction, jamais vide ni en double', async () => {
    const { as, db, hook } = await setupWithSonarrHook();
    const member = await as('member', 'avance', ADVANCED);
    const { id } = await askGot(member, [1, 2]);
    // Une autre modification retire la saison 1 : garder [1] viderait la demande.
    hook.run = () =>
      db
        .delete(requestSeasons)
        .where(and(eq(requestSeasons.requestId, id), eq(requestSeasons.seasonNumber, 1)))
        .run();
    const emptied = await member.patch(`/api/requests/${id}`, { seasons: [1], qualityProfileId: 2 });
    expect(emptied.statusCode).toBe(409);
    expect(seasonsOf(db, id)).toEqual([2]);

    // Une autre modification ajoute déjà la saison 3 : pas de seconde insertion (clé primaire).
    hook.run = () => db.insert(requestSeasons).values({ requestId: id, seasonNumber: 3 }).run();
    const res = await member.patch(`/api/requests/${id}`, { seasons: [2, 3], qualityProfileId: 2 });
    expect(res.statusCode).toBe(200);
    expect(seasonsOf(db, id)).toEqual([2, 3]);
  });

  it('saisons ajoutées pendant l’approbation : 409, rien n’est envoyé', async () => {
    const { as, db, hook, servers } = await setupWithSonarrHook();
    const { id } = await askGot(await as('member'));
    hook.run = () => db.insert(requestSeasons).values({ requestId: id, seasonNumber: 2 }).run();
    const res = await (await as('owner', 'proprietaire')).post(`/api/requests/${id}/approve`, { qualityProfileId: 2 });
    expect(res.statusCode).toBe(409);
    expect(db.select().from(requests).where(eq(requests.id, id)).get()).toMatchObject({ status: 'pending' });
    expect(posted(servers.sonarr, '/api/v3/series')).toHaveLength(0);
  });

  it('choix d’envoi inchangé : pas revalidé chez Sonarr (en panne)', async () => {
    let down = false;
    const flaky: FakeHandler = (_req, res) => {
      res.writeHead(down ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(down ? {} : profiles));
    };
    const { as, db } = await setup({ sonarr: sonarrRoutes({ 'GET /api/v3/qualityprofile': flaky }) });
    const member = await as('member', 'avance', ADVANCED);
    const choice = { qualityProfileId: 2, rootFolderPath: '/anime' };
    const { id, server } = (
      await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [1], ...choice })
    ).json<RequestDetail>();
    down = true;
    const res = await member.patch(`/api/requests/${id}`, { seasons: [1, 2], serverId: server?.id, ...choice });
    expect(res.statusCode).toBe(200);
    expect(seasonsOf(db, id)).toEqual([1, 2]);
  });

  it('film : choix d’envoi seul modifiable, type de série refusé (400)', async () => {
    const { as } = await setup();
    const member = await as('member');
    const movie = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    const manager = await as('manager', 'gestionnaire');
    const res = await manager.patch(`/api/requests/${movie.id}`, { seriesType: 'anime' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Un film n’a pas de type de série' });
    const edited = await manager.patch(`/api/requests/${movie.id}`, { qualityProfileId: 2 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<RequestDetail>()).toMatchObject({ qualityProfileId: 2 });
  });

  it('quota : les saisons ajoutées comptent à leur date, les saisons retirées le libèrent', async () => {
    const { as, db } = await setup();
    const member = await as('member');
    setQuotaOverride(db, member.user.id, { movies: null, seasons: { limit: 2, days: 7 } });
    const { id } = await askGot(member);
    const over = await member.patch(`/api/requests/${id}`, { seasons: [1, 2, 3] });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toEqual({ error: 'Quota atteint : 2 saisons sur 7 jours (il en reste 1)' });
    expect(seasonsOf(db, id)).toEqual([1]);
    // La saison 1 retirée libère sa place : les saisons 2 et 3 tiennent dans le quota.
    const res = await member.patch(`/api/requests/${id}`, { seasons: [2, 3] });
    expect(res.statusCode).toBe(200);
    expect(seasonsOf(db, id)).toEqual([2, 3]);
    const quota = (await member.get('/api/requests/quota')).json<{ seasons: { used: number } }>();
    expect(quota.seasons.used).toBe(2);
  });
});
