import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir } from '../src/server/db/index.ts';
import { media, notifications, requests, users } from '../src/server/db/schema.ts';
import { type CreatedNotifications, onNotificationsCreated } from '../src/server/services/notifications.ts';
import { quotaUsageQuery } from '../src/server/services/requests.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { setQuotaOverride } from '../src/server/services/users.ts';
import type { Blocklist } from '../src/shared/blocklist.ts';
import type { DiscoverResponse } from '../src/shared/catalogue.ts';
import type { MediaDetails, MediaSearchResults } from '../src/shared/media.ts';
import type { RequestDetail, RequestQuota } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import type { FakeRoutes } from './fake-server.ts';
import { addArrServer, loginAs, queryPlan, trackFakeServers, trackTempDirs } from './helpers.ts';

// Lot 7.9 : demande pour un autre membre, hors quota, blocage de titres et de mots-clés, masquage dans Découvrir.

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const NOVEL = { id: 818, name: 'based on novel or book' };

const matrix = { id: 603, title: 'Matrix', release_date: '1999-03-30', overview: 'Un pirate.', poster_path: '/m.jpg' };
const reloaded = { id: 604, title: 'Matrix Reloaded', release_date: '2003-05-15', overview: 'Suite.' };
/** Film et série portant le mot-clé NOVEL (forme différente : `keywords.keywords` / `keywords.results`). */
const novelMovie = { id: 700, title: 'Le Roman', release_date: '2001-01-01', overview: 'Adapté.' };
const breakingBad = {
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  overview: 'Chimie.',
  seasons: [{ season_number: 1, episode_count: 7, air_date: '2008-01-20' }],
  external_ids: { tvdb_id: 81189 },
};
/** Série de trois saisons diffusées, sans mot-clé bloqué : ajouts de saisons à une demande en attente. */
const got = {
  id: 1399,
  name: 'Game of Thrones',
  first_air_date: '2011-04-17',
  overview: 'Trônes.',
  seasons: [1, 2, 3].map((n) => ({ season_number: n, episode_count: 10, air_date: `${2010 + n}-04-17` })),
  external_ids: { tvdb_id: 121361 },
};
const page = (results: unknown[]) => ({ page: 1, total_pages: 1, results });

const tmdbRoutes: FakeRoutes = {
  'GET /movie/603': matrix,
  'GET /movie/604': reloaded,
  'GET /movie/700': { ...novelMovie, keywords: { keywords: [NOVEL] } },
  'GET /tv/1396': { ...breakingBad, keywords: { results: [NOVEL] } },
  'GET /tv/1399': got,
  'GET /trending/all/week': page([
    { ...matrix, media_type: 'movie' },
    { ...reloaded, media_type: 'movie' },
    { ...novelMovie, media_type: 'movie' },
  ]),
  'GET /movie/popular': page([matrix]),
  'GET /tv/popular': page([]),
  'GET /movie/upcoming': page([]),
  'GET /search/multi': page([
    { ...matrix, media_type: 'movie' },
    { ...reloaded, media_type: 'movie' },
  ]),
  'GET /discover/movie': page([matrix, reloaded]),
  'GET /search/keyword': { page: 1, total_pages: 1, results: [NOVEL, { id: 9, name: ' ' }] },
};

const radarrRoutes: FakeRoutes = {
  // Matrix Reloaded est déjà là (fichier présent) : « disponible ».
  'GET /api/v3/movie': [{ id: 9, tmdbId: 604, hasFile: true, monitored: true }],
  'GET /api/v3/queue': { totalRecords: 0, records: [] },
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  'GET /api/v3/qualityprofile': [{ id: 1, name: 'HD' }],
  'GET /api/v3/rootfolder': [{ id: 1, path: '/films', freeSpace: 1 }],
};

interface Actor {
  user: { id: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
  put: (url: string, payload: object) => Promise<LightMyRequestResponse>;
  del: (url: string) => Promise<LightMyRequestResponse>;
}

async function setup() {
  const tmdb = await startServer(tmdbRoutes);
  const radarr = await startServer(radarrRoutes);
  const radarr4k = await startServer({ ...radarrRoutes, 'GET /api/v3/movie': [] });
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  addArrServer(data, { type: 'radarr', url: radarr.url, rootFolderPath: '/films' });
  addArrServer(data, { type: 'radarr', url: radarr4k.url, is4k: true, rootFolderPath: '/films' });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload && { payload }) });
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => send('POST', url, payload),
      put: (url, payload) => send('PUT', url, payload),
      del: (url) => send('DELETE', url),
    };
  };
  return { db: data.db, tmdb, radarr, as };
}

const rowOf = (db: Db, id: number) => db.select().from(requests).where(eq(requests.id, id)).get();
const notificationsOf = (db: Db, userId: string) =>
  db.select().from(notifications).where(eq(notifications.userId, userId)).all();
const discoverIds = (res: LightMyRequestResponse) =>
  Object.fromEntries(res.json<DiscoverResponse>().rows.map((row) => [row.id, row.items.map((i) => i.tmdbId)]));

// --- Demander pour un autre membre ---

describe('demande pour un autre membre', () => {
  it('appartient au membre : quota et notification du membre, auteur gardé dans `created_by`', async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    // Courriel et push s'abonnent ici (`notify`) : la notification du membre part aussi par ces canaux.
    const created: CreatedNotifications[] = [];
    cleanups.push(onNotificationsCreated((c) => created.push(c)));
    const res = await manager.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: member.user.id });

    expect(res.statusCode).toBe(201);
    expect(created).toMatchObject([{ kind: 'requested_on_behalf', rows: [{ userId: member.user.id }] }]);
    const request = res.json<RequestDetail>();
    expect(request).toMatchObject({
      status: 'pending',
      requester: { id: member.user.id },
      createdBy: { id: manager.user.id },
      quotaExempt: false,
    });
    expect(request.events).toMatchObject([{ type: 'requested', actor: { id: manager.user.id } }]);
    expect(rowOf(db, request.id)).toMatchObject({ userId: member.user.id, createdBy: manager.user.id });
    // Le membre est prévenu ; l'auteur ne reçoit rien.
    expect(notificationsOf(db, member.user.id).map((n) => n.kind)).toEqual(['requested_on_behalf']);
    expect(notificationsOf(db, manager.user.id)).toEqual([]);
    // Compté dans le quota du membre, lu par le gestionnaire.
    const quota = await manager.get(`/api/requests/quota?userId=${member.user.id}`);
    expect(quota.json<RequestQuota>()).toMatchObject({ exempt: false, movies: { used: 1 } });
    // Le membre la voit dans ses demandes.
    const mine = await member.get('/api/requests?mine=true');
    expect(mine.json().results).toMatchObject([{ id: request.id, createdBy: { id: manager.user.id } }]);
  });

  it('suit l’approbation automatique du membre, pas celle de l’auteur', async () => {
    const { db, as, radarr } = await setup();
    const sentTo = () => radarr.requests.filter((r) => r.method === 'POST' && r.path === '/api/v3/movie');
    const owner = await as('owner');
    const member = await as('member');
    const pending = await owner.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: member.user.id });
    expect(pending.json<RequestDetail>().status).toBe('pending');

    const auto = await as('auto_approve');
    const watcher = await as('manager', 'gestionnaire-attentif');
    // « Approuvée automatiquement » : désactivé d'office, ces deux-là l'activent.
    for (const id of [owner.user.id, watcher.user.id])
      db.update(users)
        .set({ notificationTypes: { auto_approved: true } })
        .where(eq(users.id, id))
        .run();
    expect(sentTo()).toHaveLength(0);
    const sent = await owner.post('/api/requests', { type: 'movie', tmdbId: 700, forUserId: auto.user.id });
    expect(sent.statusCode).toBe(201);
    expect(sent.json<RequestDetail>()).toMatchObject({ status: 'sent', decidedBy: { id: auto.user.id } });
    expect(sentTo()).toHaveLength(1);
    // Approuvée au nom du membre : il n'est pas prévenu de « sa » propre approbation.
    expect(notificationsOf(db, auto.user.id).map((n) => n.kind)).toEqual(['requested_on_behalf']);
    // Ni le gestionnaire qui a demandé à sa place (c'est lui qui agit), mais bien les autres qui suivent les demandes.
    expect(notificationsOf(db, owner.user.id).map((n) => n.kind)).not.toContain('auto_approved');
    expect(notificationsOf(db, watcher.user.id).map((n) => n.kind)).toContain('auto_approved');
  });

  it('applique le quota du membre ; « Hors quota » le saute sans le consommer', async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    setQuotaOverride(db, member.user.id, { movies: { limit: 0, days: 7 }, seasons: null });

    const refused = await manager.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: member.user.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/^Quota atteint/);

    const exempt = await manager.post('/api/requests', {
      type: 'movie',
      tmdbId: 603,
      forUserId: member.user.id,
      quotaExempt: true,
    });
    expect(exempt.statusCode).toBe(201);
    expect(exempt.json<RequestDetail>().quotaExempt).toBe(true);
    const quota = await manager.get(`/api/requests/quota?userId=${member.user.id}`);
    expect(quota.json<RequestQuota>().movies.used).toBe(0);
  });

  it('ajout fusionné dans la demande du membre : il est prévenu, `created_by` renseigné une seule fois', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const manager = await as('manager');
    const other = await as('manager', 'autre-gestionnaire');
    const { id } = (
      await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [1] })
    ).json<RequestDetail>();
    expect(rowOf(db, id)?.createdBy).toBeNull();

    const merged = await manager.post('/api/requests', {
      type: 'tv',
      tmdbId: 1399,
      seasons: [2],
      forUserId: member.user.id,
    });
    expect(merged.json<RequestDetail>()).toMatchObject({ id, seasons: [1, 2], createdBy: { id: manager.user.id } });
    expect(notificationsOf(db, member.user.id).map((n) => n.kind)).toEqual(['requested_on_behalf']);

    await other.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [3], forUserId: member.user.id });
    expect(rowOf(db, id)?.createdBy).toBe(manager.user.id);
    expect(notificationsOf(db, member.user.id).map((n) => n.kind)).toEqual([
      'requested_on_behalf',
      'requested_on_behalf',
    ]);
  });

  it('membre visé gestionnaire : seulement « demandée pour vous »', async () => {
    const { db, as } = await setup();
    const owner = await as('owner');
    const manager = await as('manager');
    const res = await owner.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: manager.user.id });
    expect(res.statusCode).toBe(201);
    expect(notificationsOf(db, manager.user.id).map((n) => n.kind)).toEqual(['requested_on_behalf']);
  });

  it('403 sans le droit « Demander pour un autre », 404 pour un membre inconnu', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const other = await as('auto_approve');
    const res = await member.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: other.user.id });
    expect(res.statusCode).toBe(403);
    expect((await member.get(`/api/requests/quota?userId=${other.user.id}`)).statusCode).toBe(403);
    // Pour soi-même : accepté comme une demande ordinaire.
    const self = await member.post('/api/requests', { type: 'movie', tmdbId: 603, forUserId: member.user.id });
    expect(self.statusCode).toBe(201);
    expect(self.json<RequestDetail>().createdBy).toBeNull();

    const manager = await as('manager');
    const unknown = await manager.post('/api/requests', { type: 'movie', tmdbId: 604, forUserId: 'inconnu' });
    expect(unknown.statusCode).toBe(404);
    expect(db.select().from(requests).all()).toHaveLength(1);
  });
});

// --- Hors quota ---

describe('exemption de quota', () => {
  it('un membre ne peut pas l’envoyer (403), rien n’est créé', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const res = await member.post('/api/requests', { type: 'movie', tmdbId: 603, quotaExempt: true });
    expect(res.statusCode).toBe(403);
    expect(db.select().from(requests).all()).toHaveLength(0);
  });

  it('une demande exemptée ne compte pas ; l’index du quota sert toujours la requête', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    await member.post('/api/requests', { type: 'movie', tmdbId: 603 });
    const since = new Date(Date.now() - 86_400_000);
    expect(quotaUsageQuery(db, member.user.id, 'movies', since).get()?.n).toBe(1);
    db.update(requests).set({ quotaExempt: true }).run();
    expect(quotaUsageQuery(db, member.user.id, 'movies', since).get()?.n).toBe(0);
    expect(queryPlan(db, quotaUsageQuery(db, member.user.id, 'movies', since))).toMatch(/requests_user_id_created_at/);
  });

  it('des saisons ajoutées sans exemption retirent l’exemption : le quota compte toute la demande', async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    setQuotaOverride(db, member.user.id, { movies: null, seasons: { limit: 2, days: 7 } });
    const exempt = await manager.post('/api/requests', {
      type: 'tv',
      tmdbId: 1399,
      seasons: [1],
      forUserId: member.user.id,
      quotaExempt: true,
    });
    const { id } = exempt.json<RequestDetail>();
    expect(rowOf(db, id)?.quotaExempt).toBe(true);

    // 1 saison déjà dans la demande + 2 ajoutées = 3 > 2 : refusé, l'exemption ne couvre pas l'ajout.
    const over = await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [2, 3] });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatch(/^Quota atteint/);

    const added = await member.post('/api/requests', { type: 'tv', tmdbId: 1399, seasons: [2] });
    expect(added.json<RequestDetail>()).toMatchObject({ id, seasons: [1, 2], quotaExempt: false });
    const quota = await member.get('/api/requests/quota');
    expect(quota.json<RequestQuota>().seasons.used).toBe(2);

    // Un ajout lui-même hors quota rend la demande exemptée tout entière.
    await manager.post('/api/requests', {
      type: 'tv',
      tmdbId: 1399,
      seasons: [3],
      forUserId: member.user.id,
      quotaExempt: true,
    });
    expect(rowOf(db, id)?.quotaExempt).toBe(true);
  });

  it('se coche à l’approbation', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const manager = await as('manager');
    const { id } = (await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    const approved = await manager.post(`/api/requests/${id}/approve`, { quotaExempt: true });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<RequestDetail>().quotaExempt).toBe(true);
    expect(rowOf(db, id)?.quotaExempt).toBe(true);
  });
});

// --- Blocage de titres ---

describe('blocage de titres', () => {
  it('un titre bloqué n’est plus demandable (403), sa fiche est marquée, les demandes en attente restent', async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    const other = await as('member', 'autre-membre');
    const { id: pendingId } = (await other.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

    const blocked = await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json<Blocklist>().titles).toMatchObject([
      { mediaType: 'movie', tmdbId: 603, title: 'Matrix', blockedBy: `Nom ${manager.user.id}` },
    ]);
    // Idempotent.
    expect((await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 })).statusCode).toBe(200);

    db.update(requests).set({ status: 'cancelled' }).run();
    const refused = await member.post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('Ce titre est bloqué : il ne peut pas être demandé');
    expect((await manager.post('/api/requests', { type: 'movie', tmdbId: 603 })).statusCode).toBe(403);
    expect((await member.get('/api/media/movie/603')).json<MediaDetails>().blocked).toEqual({ by: 'title' });
    expect(rowOf(db, pendingId)).toBeDefined();

    const unblocked = await manager.del('/api/blocklist/titles/movie/603');
    expect(unblocked.json<Blocklist>().titles).toEqual([]);
    expect((await member.get('/api/media/movie/603')).json<MediaDetails>().blocked).toBeUndefined();
    expect((await member.post('/api/requests', { type: 'movie', tmdbId: 603 })).statusCode).toBe(201);
  });

  it('retiré de Découvrir et de la recherche pour les membres, marqué pour les gestionnaires', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 });

    expect(discoverIds(await member.get('/api/discover')).trending).toEqual([604, 700]);
    expect(discoverIds(await member.get('/api/discover'))['popular-movies']).toBeUndefined();
    const forManager = (await manager.get('/api/discover')).json<DiscoverResponse>();
    expect(forManager.rows[0]?.items.map((i) => [i.tmdbId, i.blocked])).toEqual([
      [603, { by: 'title' }],
      [604, undefined],
      [700, undefined],
    ]);
    const search = (q: Actor) => q.get('/api/search?q=matrix').then((r) => r.json<MediaSearchResults>().results);
    expect((await search(member)).map((i) => i.tmdbId)).toEqual([604]);
    expect((await search(manager)).map((i) => i.tmdbId)).toEqual([603, 604]);
    expect((await member.get('/api/discover/movie?genres=28')).json().results).toMatchObject([{ tmdbId: 604 }]);
  });

  it('réservé au droit « Gérer les blocages » ; un titre inconnu de TMDB → 404', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    expect((await member.get('/api/blocklist')).statusCode).toBe(403);
    expect((await member.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 })).statusCode).toBe(403);
    expect((await member.del('/api/blocklist/titles/movie/603')).statusCode).toBe(403);
    expect((await member.put('/api/blocklist/keywords', { keywords: [NOVEL] })).statusCode).toBe(403);
    expect((await member.get('/api/blocklist/keywords/search?q=x')).statusCode).toBe(403);
    const manager = await as('manager');
    expect((await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 999 })).statusCode).toBe(404);
    expect(db.select().from(media).all()).toEqual([]);
  });
});

// --- Blocage par mot-clé ---

describe('blocage par mot-clé', () => {
  it('fiche marquée et demande refusée, pour un film (`keywords.keywords`) et une série (`keywords.results`)', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    const saved = await manager.put('/api/blocklist/keywords', { keywords: [NOVEL, NOVEL] });
    expect(saved.json<Blocklist>().keywords).toEqual([NOVEL]);

    for (const [type, id] of [
      ['movie', 700],
      ['tv', 1396],
    ] as const) {
      const fiche = (await member.get(`/api/media/${type}/${id}`)).json<MediaDetails>();
      expect(fiche.blocked).toEqual({ by: 'keyword', keyword: NOVEL.name });
      const res = await member.post('/api/requests', { type, tmdbId: id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(`Ce titre est bloqué (mot-clé « ${NOVEL.name} ») : il ne peut pas être demandé`);
    }
    expect((await member.get('/api/media/movie/603')).json<MediaDetails>().blocked).toBeUndefined();
  });

  it('rangées /discover : `without_keywords` pour les membres, pas pour les gestionnaires', async () => {
    const { as, tmdb } = await setup();
    const manager = await as('manager');
    const member = await as('member');
    await manager.put('/api/blocklist/keywords', { keywords: [NOVEL, { id: 9715, name: 'superhero' }] });

    await member.get('/api/discover/movie?genres=28');
    await manager.get('/api/discover/movie?genres=28&page=2');
    const discover = tmdb.requests.filter((r) => r.path === '/discover/movie');
    expect(discover.map((r) => r.query.without_keywords)).toEqual(['818|9715', undefined]);
  });

  it('recherche de mots-clés TMDB (noms vides écartés)', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    const res = await manager.get('/api/blocklist/keywords/search?q=novel');
    expect(res.json()).toEqual([NOVEL]);
  });
});

// --- Masquer dans Découvrir ---

describe('masquer dans Découvrir', () => {
  it('réglage du propriétaire seulement', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    expect((await manager.put('/api/settings/discover', { hideAvailable: true })).statusCode).toBe(403);
    const owner = await as('owner');
    expect((await owner.get('/api/settings/discover')).json()).toEqual({ hideAvailable: false, hideRequested: false });
    const saved = await owner.put('/api/settings/discover', { hideAvailable: true });
    expect(saved.json()).toEqual({ hideAvailable: true, hideRequested: false });
  });

  it('masque les disponibles et les déjà demandés (4K compris) des rangées, pas de la recherche', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    const member = await as('member');
    expect(discoverIds(await member.get('/api/discover')).trending).toEqual([603, 604, 700]);

    await owner.put('/api/settings/discover', { hideAvailable: true });
    expect(discoverIds(await member.get('/api/discover')).trending).toEqual([603, 700]);

    await owner.put('/api/settings/discover', { hideAvailable: false, hideRequested: true });
    await member.post('/api/requests', { type: 'movie', tmdbId: 700, is4k: true });
    const ids = discoverIds(await member.get('/api/discover'));
    expect(ids.trending).toEqual([603, 604]);

    await member.post('/api/requests', { type: 'movie', tmdbId: 603 });
    const hidden = discoverIds(await member.get('/api/discover'));
    expect(hidden.trending).toEqual([604]);
    // Rangée vidée par le masquage : omise.
    expect(hidden['popular-movies']).toBeUndefined();
    const search = await member.get('/api/search?q=matrix');
    expect(search.json<MediaSearchResults>().results.map((i) => i.tmdbId)).toEqual([603, 604]);
  });
});

// --- Rangée « Demandes récentes » (lot 8.6) ---

describe('rangée « Demandes récentes »', () => {
  const recent = async (actor: Actor) => discoverIds(await actor.get('/api/discover'))['recent-requests'];

  it('omise sans demande ; sinon les titres demandés par tous, le plus récent d’abord, sans le demandeur', async () => {
    const { as } = await setup();
    const viewer = await as('member', 'membre-spectateur');
    expect(await recent(viewer)).toBeUndefined();

    await (await as('member', 'membre-a')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    await (await as('manager')).post('/api/requests', { type: 'movie', tmdbId: 700 });
    const res = await viewer.get('/api/discover');
    const rows = res.json<DiscoverResponse>().rows;
    expect(rows.map((r) => r.id).slice(0, 3)).toEqual(['trending', 'recent-requests', 'popular-movies']);
    expect(discoverIds(res)['recent-requests']).toEqual([700, 603]);
    expect(res.body).not.toContain('membre-a');
  });

  it('écarte les demandes refusées et annulées, et un titre demandé deux fois n’apparaît qu’une fois', async () => {
    const { db, as } = await setup();
    const viewer = await as('member', 'membre-spectateur');
    const manager = await as('manager');
    await (await as('member', 'membre-a')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    await (await as('member', 'membre-b')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    await manager.post('/api/requests', { type: 'movie', tmdbId: 700 });
    expect(await recent(viewer)).toEqual([700, 603]);

    db.update(requests).set({ status: 'declined' }).where(eq(requests.userId, manager.user.id)).run();
    expect(await recent(viewer)).toEqual([603]);
    db.update(requests).set({ status: 'cancelled' }).run();
    expect(await recent(viewer)).toBeUndefined();
  });

  it('respecte les blocages (retirés pour les membres, marqués pour les gestionnaires) et « masquer déjà demandés »', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    const manager = await as('manager');
    const member = await as('member');
    await member.post('/api/requests', { type: 'movie', tmdbId: 603 });
    await member.post('/api/requests', { type: 'movie', tmdbId: 700 });
    await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 });

    expect(await recent(member)).toEqual([700]);
    const forManager = (await manager.get('/api/discover')).json<DiscoverResponse>();
    expect(forManager.rows.find((r) => r.id === 'recent-requests')?.items.map((i) => [i.tmdbId, i.blocked])).toEqual([
      [700, undefined],
      [603, { by: 'title' }],
    ]);

    await owner.put('/api/settings/discover', { hideRequested: true });
    expect(await recent(member)).toBeUndefined();
  });
});
