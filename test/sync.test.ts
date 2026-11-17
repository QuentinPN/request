import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir } from '../src/server/db/index.ts';
import { jobRuns, media, requestEvents, requestSeasons, requests, seasons } from '../src/server/db/schema.ts';
import { startJob } from '../src/server/services/jobs.ts';
import { setSetting } from '../src/server/services/settings.ts';
import {
  createSync,
  FULL_SCAN_INTERVAL_MS,
  LIGHT_SCAN_INTERVAL_MS,
  PURGE_AFTER_MS,
  purgeMedia,
  SCAN_JOBS,
  startScheduler,
} from '../src/server/services/sync.ts';
import { upsertFromEmby } from '../src/server/services/users.ts';
import { webhookToken } from '../src/server/services/webhooks.ts';
import type { MediaType } from '../src/shared/media.ts';
import type { MediaStatus, RequestStatus } from '../src/shared/status.ts';
import { WEBHOOK_TOKEN_HEADER, type WebhookSettings } from '../src/shared/webhooks.ts';
import type { FakeRequest } from './fake-server.ts';
import { loginAs, loginAsOwner, queryPlan, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const DAY_MS = 24 * 3600 * 1000;

// --- Faux Radarr et Sonarr, à l'état modifiable ---

interface Library {
  movies: Array<{ id: number; tmdbId: number; hasFile: boolean }>;
  /** `seasons` : `[saison, fichiers, épisodes]`. */
  series: Array<{ id: number; tvdbId: number; tmdbId?: number; seasons: Array<[number, number, number]> }>;
}

const queue = { totalRecords: 0, records: [] };
const calls = (requests: FakeRequest[], path: string) => requests.filter((r) => r.path === path).length;

async function setup() {
  const library: Library = { movies: [], series: [] };
  const radarr = await startServer({
    'GET /api/v3/movie': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(library.movies.map((m) => ({ ...m, monitored: true }))));
    },
    'GET /api/v3/queue': queue,
  });
  const sonarr = await startServer({
    'GET /api/v3/series': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          library.series.map(({ seasons: list, ...s }) => ({
            ...s,
            monitored: true,
            seasons: list.map(([seasonNumber, episodeFileCount, episodeCount]) => ({
              seasonNumber,
              monitored: true,
              statistics: { episodeFileCount, episodeCount, totalEpisodeCount: episodeCount },
            })),
          })),
        ),
      );
    },
    'GET /api/v3/queue': queue,
  });
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  const arr = { apiKey: 'k', qualityProfileId: 1, rootFolderPath: '/data' };
  setSetting(db, cryptoKey, 'radarr', { url: radarr.url, ...arr });
  setSetting(db, cryptoKey, 'sonarr', { url: sonarr.url, ...arr });
  const app = await buildApp({ data });
  cleanups.push(() => app.close());
  const sync = createSync(data, { availability: app.availability });
  const token = webhookToken(data);
  const hook = (service: 'radarr' | 'sonarr', payload: object) =>
    app.inject({ method: 'POST', url: `/api/webhooks/${service}?token=${token}`, payload });
  return { app, db, library, radarr, sonarr, sync, token, hook };
}

/** Titre (et demande de ce statut, saisons comprises) écrit directement en base. */
function seed(
  db: Db,
  {
    type = 'movie',
    tmdbId,
    tvdbId = null,
    status = null,
    request,
    requestedSeasons = [],
    statusUpdatedAt = new Date(),
  }: {
    type?: MediaType;
    tmdbId: number;
    tvdbId?: number | null;
    status?: MediaStatus | null;
    request?: RequestStatus;
    requestedSeasons?: number[];
    statusUpdatedAt?: Date;
  },
) {
  const row = db.insert(media).values({ type, tmdbId, tvdbId, status, statusUpdatedAt }).returning().get();
  if (!request) return { mediaId: row.id, requestId: undefined };
  upsertFromEmby(db, { id: 'membre', name: 'Membre', avatar: null, isEmbyAdmin: false });
  const req = db.insert(requests).values({ mediaId: row.id, userId: 'membre', status: request }).returning().get();
  for (const seasonNumber of requestedSeasons)
    db.insert(requestSeasons).values({ requestId: req.id, seasonNumber }).run();
  return { mediaId: row.id, requestId: req.id };
}

const mediaRow = (db: Db, id: number) => db.select().from(media).where(eq(media.id, id)).get();
const requestStatus = (db: Db, id: number | undefined) =>
  db
    .select()
    .from(requests)
    .where(eq(requests.id, id ?? -1))
    .get()?.status;
const eventsOf = (db: Db, id: number | undefined) =>
  db
    .select({ type: requestEvents.type, actorId: requestEvents.actorId })
    .from(requestEvents)
    .where(eq(requestEvents.requestId, id ?? -1))
    .orderBy(asc(requestEvents.id))
    .all();
const seasonStatuses = (db: Db, mediaId: number) =>
  Object.fromEntries(
    db
      .select()
      .from(seasons)
      .where(eq(seasons.mediaId, mediaId))
      .all()
      .map((s) => [s.seasonNumber, s.status]),
  );

// --- Authentification ---

describe('webhooks : jeton', () => {
  it('sans jeton ou avec un mauvais jeton → 401 ; bon jeton (adresse ou en-tête) → 200', async () => {
    const { app, token } = await setup();
    const post = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url, headers, payload: { eventType: 'Test' } });
    expect((await post('/api/webhooks/radarr')).statusCode).toBe(401);
    expect((await post('/api/webhooks/radarr?token=faux')).statusCode).toBe(401);
    expect((await post('/api/webhooks/sonarr', { [WEBHOOK_TOKEN_HEADER]: 'faux' })).statusCode).toBe(401);
    expect((await post(`/api/webhooks/sonarr?token=${token.slice(0, -1)}`)).statusCode).toBe(401);
    const ok = await post(`/api/webhooks/radarr?token=${token}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ handled: true });
    expect((await post('/api/webhooks/sonarr', { [WEBHOOK_TOKEN_HEADER]: token })).statusCode).toBe(200);
  });

  it('jeton vérifié avant la lecture du corps : un corps illisible sans jeton reste un 401', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/radarr',
      headers: { 'content-type': 'application/json' },
      payload: '{pas du json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('aucun jeton encore généré : tout webhook est refusé', async () => {
    const app = await buildApp({ data: openDataDir(tempDir()) });
    cleanups.push(() => app.close());
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/radarr?token=', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("l'exemption ne couvre que les deux webhooks : le reste de l'API garde session et CSRF", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/requests' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/webhooks/radarr' })).statusCode).toBe(404);
    const { headers } = await loginAsOwner(app);
    const { 'x-request': _csrf, ...withoutCsrf } = headers;
    const res = await app.inject({ method: 'POST', url: '/api/settings/webhooks/token', headers: withoutCsrf });
    expect(res.statusCode).toBe(403);
  });
});

describe('réglages des webhooks', () => {
  it('propriétaire seulement : jeton et adresses ; membre → 403, sans session → 401', async () => {
    const { app, token } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings/webhooks' })).statusCode).toBe(401);
    const member = await loginAs(app, 'manager');
    const denied = await app.inject({ method: 'GET', url: '/api/settings/webhooks', headers: member.headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(token);

    const { headers } = await loginAsOwner(app);
    const res = await app.inject({ method: 'GET', url: '/api/settings/webhooks', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      token,
      urls: {
        radarr: `http://localhost/api/webhooks/radarr?token=${token}`,
        sonarr: `http://localhost/api/webhooks/sonarr?token=${token}`,
      },
    } satisfies WebhookSettings);
    // Pas confondu avec le réglage générique `/api/settings/:service`.
    expect((await app.inject({ method: 'PUT', url: '/api/settings/webhooks', headers, payload: {} })).statusCode).toBe(
      404,
    );
  });

  it("régénération : nouveau jeton, l'ancien est aussitôt refusé", async () => {
    const { app, token } = await setup();
    const { headers } = await loginAsOwner(app);
    const res = await app.inject({ method: 'POST', url: '/api/settings/webhooks/token', headers });
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as WebhookSettings).token;
    expect(fresh).not.toBe(token);
    expect(fresh.length).toBeGreaterThanOrEqual(43);
    const post = (t: string) =>
      app.inject({ method: 'POST', url: `/api/webhooks/radarr?token=${t}`, payload: { eventType: 'Test' } });
    expect((await post(token)).statusCode).toBe(401);
    expect((await post(fresh)).statusCode).toBe(200);
    const member = await loginAs(app, 'member');
    const denied = await app.inject({ method: 'POST', url: '/api/settings/webhooks/token', headers: member.headers });
    expect(denied.statusCode).toBe(403);
  });

  it('jeton chiffré en base, jamais en clair', async () => {
    const { db, token } = await setup();
    const stored = db.$client.prepare("select value from settings where key = 'webhooks'").get() as { value: string };
    expect(stored.value).not.toContain(token);
  });
});

// --- Évènements ---

describe('webhooks Radarr', () => {
  it('Test et évènements sans intérêt : 200, rien de modifié', async () => {
    const { db, hook } = await setup();
    const { mediaId } = seed(db, { tmdbId: 603 });
    for (const eventType of ['Test', 'Rename', 'Health', 'Inconnu']) {
      const res = await hook('radarr', { eventType, movie: { tmdbId: 603 } });
      expect(res.statusCode).toBe(200);
    }
    expect((await hook('radarr', { eventType: 'Rename', movie: { tmdbId: 603 } })).json()).toEqual({ handled: false });
    expect((await hook('radarr', { pas: 'un webhook' })).statusCode).toBe(200);
    expect(mediaRow(db, mediaId)?.status).toBeNull();
  });

  it('titre inconnu de l’appli : 200, ignoré, rien de créé', async () => {
    const { db, hook } = await setup();
    const res = await hook('radarr', { eventType: 'Download', movie: { tmdbId: 999 } });
    expect(res.json()).toEqual({ handled: false });
    expect(db.select().from(media).all()).toEqual([]);
  });

  it('Grab → en téléchargement, sauf un titre déjà disponible (mise à niveau)', async () => {
    const { db, hook } = await setup();
    const { mediaId } = seed(db, { tmdbId: 603, statusUpdatedAt: new Date(0) });
    const { mediaId: upgraded } = seed(db, { tmdbId: 604, status: 'available' });
    expect((await hook('radarr', { eventType: 'Grab', movie: { tmdbId: 603 } })).json()).toEqual({ handled: true });
    await hook('radarr', { eventType: 'Grab', movie: { tmdbId: 604 } });
    const row = mediaRow(db, mediaId);
    expect(row?.status).toBe('downloading');
    expect(row?.statusUpdatedAt.getTime()).toBeGreaterThan(0);
    expect(mediaRow(db, upgraded)?.status).toBe('available');
  });

  it('Download → ce seul titre recalculé, liste Radarr relue ; la demande envoyée passe disponible, une fois', async () => {
    const { db, library, radarr, hook, app } = await setup();
    const { mediaId, requestId } = seed(db, { tmdbId: 603, request: 'sent' });
    const { mediaId: other } = seed(db, { tmdbId: 700, status: 'downloading', statusUpdatedAt: new Date(0) });
    // Liste Radarr mise en cache par une page d'affiches.
    await app.availability.statusesFor([{ type: 'movie', tmdbId: 603 }]);
    const before = calls(radarr.requests, '/api/v3/movie');

    library.movies.push({ id: 1, tmdbId: 603, hasFile: true });
    expect((await hook('radarr', { eventType: 'Download', movie: { tmdbId: 603 } })).json()).toEqual({
      handled: true,
    });
    expect(calls(radarr.requests, '/api/v3/movie')).toBe(before + 1);
    expect(mediaRow(db, mediaId)).toMatchObject({ status: 'available', radarrId: 1 });
    expect(mediaRow(db, other)?.status).toBe('downloading'); // pas touché
    expect(requestStatus(db, requestId)).toBe('available');
    expect(eventsOf(db, requestId)).toEqual([{ type: 'available', actorId: null }]);

    // Webhook rejoué : même état, aucun évènement en double.
    await hook('radarr', { eventType: 'Download', movie: { tmdbId: 603 } });
    expect(eventsOf(db, requestId)).toHaveLength(1);
  });

  it('MovieDelete / MovieFileDelete → recalcul : le titre disparaît de la bibliothèque', async () => {
    const { db, library, hook } = await setup();
    const { mediaId } = seed(db, { tmdbId: 603, status: 'available' });
    library.movies.push({ id: 1, tmdbId: 603, hasFile: false });
    await hook('radarr', { eventType: 'MovieFileDelete', movie: { tmdbId: 603 } });
    expect(mediaRow(db, mediaId)?.status).toBeNull();
    seed(db, { tmdbId: 604, status: 'available' });
    await hook('radarr', { eventType: 'MovieDelete', movie: { tmdbId: 604 } });
    expect(db.select().from(media).where(eq(media.tmdbId, 604)).get()?.status).toBeNull();
  });

  it('une demande pas encore envoyée ne change pas', async () => {
    const { db, library, hook } = await setup();
    const { requestId } = seed(db, { tmdbId: 603, request: 'pending' });
    library.movies.push({ id: 1, tmdbId: 603, hasFile: true });
    await hook('radarr', { eventType: 'Download', movie: { tmdbId: 603 } });
    expect(requestStatus(db, requestId)).toBe('pending');
  });
});

describe('webhooks Sonarr', () => {
  it('Grab → la série et ses saisons concernées passent en téléchargement (une saison disponible reste)', async () => {
    const { db, hook } = await setup();
    const { mediaId } = seed(db, { type: 'tv', tmdbId: 1396, tvdbId: 81189, status: 'partial' });
    db.insert(seasons).values({ mediaId, seasonNumber: 1, status: 'available' }).run();
    await hook('sonarr', {
      eventType: 'Grab',
      series: { tvdbId: 81189 },
      episodes: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    });
    expect(mediaRow(db, mediaId)?.status).toBe('downloading');
    expect(seasonStatuses(db, mediaId)).toEqual({ 1: 'available', 2: 'downloading' });
  });

  it('Download, série complète : demande disponible ; identifiée par son id TVDB (Sonarr v3)', async () => {
    const { db, library, hook } = await setup();
    const { requestId } = seed(db, {
      type: 'tv',
      tmdbId: 1396,
      tvdbId: 81189,
      request: 'sent',
      requestedSeasons: [1, 2],
    });
    library.series.push({
      id: 7,
      tvdbId: 81189,
      tmdbId: 1396,
      seasons: [
        [1, 7, 7],
        [2, 13, 13],
      ],
    });
    await hook('sonarr', { eventType: 'Download', series: { tvdbId: 81189 }, episodes: [{ seasonNumber: 2 }] });
    expect(requestStatus(db, requestId)).toBe('available');
    expect(eventsOf(db, requestId).map((e) => e.type)).toEqual(['available']);
  });

  it('saisons demandées toutes arrivées (une autre manque encore) : disponible', async () => {
    const { db, library, hook } = await setup();
    const { mediaId, requestId } = seed(db, { type: 'tv', tmdbId: 1396, request: 'sent', requestedSeasons: [1] });
    library.series.push({
      id: 7,
      tvdbId: 81189,
      tmdbId: 1396,
      seasons: [
        [1, 7, 7],
        [2, 3, 13],
      ],
    });
    await hook('sonarr', { eventType: 'Download', series: { tmdbId: 1396, tvdbId: 81189 } });
    expect(mediaRow(db, mediaId)?.status).toBe('partial');
    expect(requestStatus(db, requestId)).toBe('available');
  });

  it('série partielle : une saison demandée manque encore, la demande reste envoyée', async () => {
    const { db, library, hook } = await setup();
    const { mediaId, requestId } = seed(db, { type: 'tv', tmdbId: 1396, request: 'sent', requestedSeasons: [1, 2] });
    library.series.push({
      id: 7,
      tvdbId: 81189,
      tmdbId: 1396,
      seasons: [
        [1, 7, 7],
        [2, 3, 13],
      ],
    });
    await hook('sonarr', { eventType: 'Download', series: { tmdbId: 1396, tvdbId: 81189 } });
    expect(mediaRow(db, mediaId)?.status).toBe('partial');
    expect(seasonStatuses(db, mediaId)).toEqual({ 1: 'available', 2: 'partial' });
    expect(requestStatus(db, requestId)).toBe('sent');
    expect(eventsOf(db, requestId)).toEqual([]);
  });

  it('SeriesDelete → recalcul', async () => {
    const { db, hook } = await setup();
    const { mediaId } = seed(db, { type: 'tv', tmdbId: 1396, tvdbId: 81189, status: 'available' });
    await hook('sonarr', { eventType: 'SeriesDelete', series: { tvdbId: 81189 } });
    expect(mediaRow(db, mediaId)?.status).toBeNull();
  });
});

// --- Balayages ---

describe('balayages', () => {
  it('verrou : un balayage déjà en cours → rien ne démarre ; deux simultanés → un seul tourne', async () => {
    const { db, sync, radarr } = await setup();
    seed(db, { tmdbId: 603, status: 'available' });
    expect(startJob(db, SCAN_JOBS.full)).not.toBeNull();
    expect(await sync.fullScan()).toBe(false);
    expect(calls(radarr.requests, '/api/v3/movie')).toBe(0);

    const [a, b] = await Promise.all([sync.lightScan(), sync.lightScan()]);
    expect([a, b].sort()).toEqual([false, true]);
    const light = db.select().from(jobRuns).where(eq(jobRuns.job, SCAN_JOBS.light)).all();
    expect(light).toHaveLength(1);
    expect(light[0]?.status).toBe('success');
  });

  it('balayage léger : titres des demandes envoyées et en téléchargement recalculés, demandes avancées', async () => {
    const { db, library, sync } = await setup();
    const { requestId } = seed(db, { tmdbId: 603, request: 'sent' });
    const { mediaId: downloading } = seed(db, { tmdbId: 604, status: 'downloading' });
    const { mediaId: ignored } = seed(db, { tmdbId: 605, status: 'available' });
    library.movies.push(
      { id: 1, tmdbId: 603, hasFile: true },
      { id: 2, tmdbId: 604, hasFile: true },
      { id: 3, tmdbId: 605, hasFile: false },
    );
    expect(await sync.lightScan()).toBe(true);
    expect(requestStatus(db, requestId)).toBe('available');
    expect(mediaRow(db, downloading)?.status).toBe('available');
    expect(mediaRow(db, ignored)?.status).toBe('available'); // hors balayage léger
  });

  it('balayage complet : tout titre suivi recalculé, demandes avancées, titres oubliés purgés', async () => {
    const { db, library, sync } = await setup();
    const { requestId } = seed(db, { tmdbId: 603, request: 'sent' });
    const { mediaId: gone } = seed(db, { tmdbId: 605, status: 'available' });
    const { mediaId: forgotten } = seed(db, { tmdbId: 606, statusUpdatedAt: new Date(Date.now() - 31 * DAY_MS) });
    library.movies.push({ id: 1, tmdbId: 603, hasFile: true });
    expect(await sync.fullScan()).toBe(true);
    expect(requestStatus(db, requestId)).toBe('available');
    expect(mediaRow(db, gone)?.status).toBeNull();
    expect(mediaRow(db, forgotten)).toBeUndefined();
    expect(db.select().from(jobRuns).where(eq(jobRuns.job, SCAN_JOBS.full)).get()).toMatchObject({
      status: 'success',
      detail: '2 titres recalculés, 1 supprimés',
    });
  });

  it('échec (Emby injoignable) : exécution enregistrée en échec, le verrou est libéré', async () => {
    const { db, sync, app } = await setup();
    setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: 'http://127.0.0.1:9', apiKey: 'k' });
    expect(await sync.lightScan()).toBe(true);
    expect(db.select().from(jobRuns).get()?.status).toBe('failed');
    expect(startJob(db, SCAN_JOBS.light)).not.toBeNull();
  });
});

describe('purge des titres', () => {
  it('sans statut, sans demande et pas recalculé depuis 30 jours : supprimé (saisons en cascade)', async () => {
    const { db } = await setup();
    const old = new Date(Date.now() - PURGE_AFTER_MS - 1000);
    const { mediaId: purged } = seed(db, { type: 'tv', tmdbId: 1, statusUpdatedAt: old });
    db.insert(seasons).values({ mediaId: purged, seasonNumber: 1, status: 'partial' }).run();
    const { mediaId: recent } = seed(db, { tmdbId: 2 });
    const { mediaId: requested } = seed(db, { tmdbId: 3, statusUpdatedAt: old, request: 'declined' });
    const { mediaId: known } = seed(db, { tmdbId: 4, statusUpdatedAt: old, status: 'available' });

    expect(purgeMedia(db, new Date(Date.now() - PURGE_AFTER_MS))).toBe(1);
    expect(mediaRow(db, purged)).toBeUndefined();
    expect(db.select().from(seasons).all()).toEqual([]);
    for (const id of [recent, requested, known]) expect(mediaRow(db, id)).toBeDefined();
  });

  it('sous-requête des demandes servie par l’index (media_id, status)', async () => {
    const { db } = await setup();
    const plan = queryPlan(db, db.select().from(requests).where(eq(requests.mediaId, 1)));
    expect(plan).toContain('requests_media_id_status_idx');
  });
});

describe('planification', () => {
  it('toutes les 10 minutes : balayage léger, puis complet si le dernier réussi date de plus d’un jour', async () => {
    const { db, sync } = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scheduler = startScheduler(sync, db);
    cleanups.push(() => scheduler.stop());
    await vi.advanceTimersByTimeAsync(LIGHT_SCAN_INTERVAL_MS - 1);
    expect(db.select().from(jobRuns).all()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(db.select().from(jobRuns).all()).toHaveLength(2));
    expect(
      db.select({ job: jobRuns.job, status: jobRuns.status }).from(jobRuns).orderBy(asc(jobRuns.id)).all(),
    ).toEqual([
      { job: SCAN_JOBS.light, status: 'success' },
      { job: SCAN_JOBS.full, status: 'success' },
    ]);
    // Tour suivant : le complet a réussi il y a moins d'un jour, seul le léger repart.
    await vi.advanceTimersByTimeAsync(LIGHT_SCAN_INTERVAL_MS);
    await vi.waitFor(() => expect(db.select().from(jobRuns).all()).toHaveLength(3));
    expect(FULL_SCAN_INTERVAL_MS).toBe(DAY_MS);
  });

  it('arrêté à la fermeture de l’appli ; désactivé par défaut (tests)', async () => {
    const data = openDataDir(tempDir());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = await buildApp({ data, schedule: true });
    expect(vi.getTimerCount()).toBe(1);
    await app.close();
    expect(vi.getTimerCount()).toBe(0);
    const quiet = await buildApp({ data: openDataDir(tempDir()) });
    cleanups.push(() => quiet.close());
    expect(vi.getTimerCount()).toBe(0);
  });
});
