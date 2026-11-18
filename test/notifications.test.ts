import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir } from '../src/server/db/index.ts';
import { notifications, requests } from '../src/server/db/schema.ts';
import {
  createNotifications,
  NOTIFICATION_RETENTION_MS,
  notificationMessage,
  purgeReadNotifications,
} from '../src/server/services/notifications.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { createSync } from '../src/server/services/sync.ts';
import { CSRF_HEADER } from '../src/shared/auth.ts';
import { NOTIFICATIONS_PAGE_SIZE, type NotificationKind, type NotificationPage } from '../src/shared/notifications.ts';
import type { RequestDetail } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import { status } from './fake-server.ts';
import { addArrServer, loginAs, queryPlan, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const DAY_MS = 24 * 3600 * 1000;

// --- Texte des messages ---

describe('notificationMessage', () => {
  const full = { title: 'Dune', requesterName: 'Marie', detail: null, serverName: 'Emby' };

  it.each<[NotificationKind, string | null, string, string]>([
    ['requested', null, 'Nouvelle demande à approuver', 'Marie a demandé « Dune ».'],
    ['approved', null, 'Demande approuvée', 'Votre demande de « Dune » a été approuvée.'],
    [
      'declined',
      'Déjà disponible en VO',
      'Demande refusée',
      'Votre demande de « Dune » a été refusée. Motif : Déjà disponible en VO',
    ],
    ['available', null, 'Disponible dans Emby', '« Dune » est disponible dans Emby.'],
    [
      'failed',
      'Radarr injoignable',
      'Échec de l’envoi',
      'L’envoi de « Dune », demandé par Marie, a échoué : Radarr injoignable',
    ],
  ])('%s', (kind, detail, title, body) => {
    expect(notificationMessage(kind, { ...full, detail })).toEqual({ title, body });
  });

  it('sans titre (TMDB en panne), sans demandeur ni détail (demande supprimée)', () => {
    const none = { title: null, requesterName: null, detail: null, serverName: 'Plex' };
    expect(notificationMessage('requested', none).body).toBe('Un membre a demandé un titre.');
    expect(notificationMessage('approved', none).body).toBe('Votre demande a été approuvée.');
    expect(notificationMessage('declined', none).body).toBe('Votre demande a été refusée.');
    expect(notificationMessage('available', none).body).toBe(
      'Le titre que vous avez demandé est disponible dans Plex.',
    );
    expect(notificationMessage('failed', none).body).toBe('L’envoi a échoué.');
  });
});

// --- Évènements ---

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};

interface Actor {
  user: { id: string; name: string };
  headers: Record<string, string>;
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
}

/** Appli branchée sur un faux TMDB (Matrix) et un faux Radarr, dont la bibliothèque et les pannes se règlent. */
async function setup() {
  const radarrState = { movies: [] as Array<{ id: number; tmdbId: number; hasFile: boolean }>, down: false };
  const tmdb = await startServer({ 'GET /movie/603': matrix });
  const radarr = await startServer({
    'GET /api/v3/movie': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(radarrState.movies.map((m) => ({ ...m, monitored: true }))));
    },
    'GET /api/v3/queue': { totalRecords: 0, records: [] },
    'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
    'POST /api/v3/movie': (req, res) =>
      radarrState.down
        ? status(500, { message: 'panne' })(req, res)
        : status(201, { id: 42, hasFile: false, monitored: true })(req, res),
  });
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
  addArrServer({ db, cryptoKey }, { type: 'radarr', url: radarr.url, rootFolderPath: '/films' });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    return {
      user,
      headers,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
    };
  };
  return { app, data, db, radarrState, as };
}

/** Membre, gestionnaire et propriétaire, créés avant toute demande (destinataires possibles). */
async function team(as: (role: Role, id?: string) => Promise<Actor>) {
  return { member: await as('member'), manager: await as('manager'), owner: await as('owner') };
}

const kindsOf = (db: Db, userId: string) =>
  db
    .select({ kind: notifications.kind })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .all()
    .map((n) => n.kind);

const requestMovie = async (actor: Actor) =>
  (await actor.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

describe('notifications des demandes', () => {
  it('nouvelle demande d’un membre : chaque gestionnaire est prévenu, pas le demandeur', async () => {
    const { db, as } = await setup();
    const { member, manager, owner } = await team(as);
    await requestMovie(member);

    expect(kindsOf(db, manager.user.id)).toEqual(['requested']);
    expect(kindsOf(db, owner.user.id)).toEqual(['requested']);
    expect(kindsOf(db, member.user.id)).toEqual([]);
    const page = (await owner.get('/api/notifications')).json<NotificationPage>();
    expect(page.results[0]).toMatchObject({
      kind: 'requested',
      title: 'Nouvelle demande à approuver',
      body: `${member.user.name} a demandé « Matrix ».`,
      read: false,
      media: { type: 'movie', tmdbId: 603 },
    });
  });

  it('approbation automatique : aucune notification (ni « à approuver », ni « approuvée » à soi-même)', async () => {
    const { db, as } = await setup();
    const { member, manager, owner } = await team(as);
    const auto = await as('auto_approve');
    expect((await requestMovie(auto)).status).toBe('sent');

    for (const actor of [member, manager, owner, auto]) expect(kindsOf(db, actor.user.id)).toEqual([]);
  });

  it('approuvée puis disponible : le demandeur est prévenu ; webhook rejoué → pas de doublon', async () => {
    const { app, data, db, radarrState, as } = await setup();
    const { member, manager, owner } = await team(as);
    const request = await requestMovie(member);
    await owner.post(`/api/requests/${request.id}/approve`);
    expect(kindsOf(db, member.user.id)).toEqual(['approved']);

    radarrState.movies.push({ id: 42, tmdbId: 603, hasFile: true });
    const sync = createSync(data, { availability: app.availability });
    const webhook = { eventType: 'Download', movie: { tmdbId: 603 } };
    await sync.handleWebhook('radarr', webhook);
    await sync.handleWebhook('radarr', webhook);

    expect(kindsOf(db, member.user.id)).toEqual(['approved', 'available']);
    expect(kindsOf(db, manager.user.id)).toEqual(['requested']);
    // Le nom du serveur multimédia est lu à l'affichage : celui du réglage courant.
    setSetting(db, data.cryptoKey, 'mediaServer', {
      kind: 'jellyfin',
      url: 'http://jellyfin.local',
      apiKey: 'k',
      libraryIds: [],
      publicUrl: null,
    });
    const [available] = (await member.get('/api/notifications')).json<NotificationPage>().results;
    expect(available).toMatchObject({
      kind: 'available',
      title: 'Disponible dans Jellyfin',
      body: '« Matrix » est disponible dans Jellyfin.',
    });
  });

  it('refusée : le demandeur est prévenu avec le motif', async () => {
    const { db, as } = await setup();
    const { member, owner } = await team(as);
    const request = await requestMovie(member);
    await owner.post(`/api/requests/${request.id}/decline`, { reason: 'Déjà en VO' });

    expect(kindsOf(db, member.user.id)).toEqual(['declined']);
    const [declined] = (await member.get('/api/notifications')).json<NotificationPage>().results;
    expect(declined?.body).toBe('Votre demande de « Matrix » a été refusée. Motif : Déjà en VO');
  });

  it('échec d’envoi : les autres gestionnaires sont prévenus, pas celui qui a approuvé', async () => {
    const { db, radarrState, as } = await setup();
    const { member, manager, owner } = await team(as);
    const request = await requestMovie(member);
    radarrState.down = true;
    expect((await (await owner.post(`/api/requests/${request.id}/approve`)).json<RequestDetail>()).status).toBe(
      'failed',
    );

    expect(kindsOf(db, manager.user.id)).toEqual(['requested', 'failed']);
    expect(kindsOf(db, owner.user.id)).toEqual(['requested']);
    expect(kindsOf(db, member.user.id)).toEqual(['approved']);
    const [failed] = (await manager.get('/api/notifications')).json<NotificationPage>().results;
    expect(failed?.title).toBe('Échec de l’envoi');
    expect(failed?.body).toMatch(new RegExp(`^L’envoi de « Matrix », demandé par ${member.user.name}, a échoué : `));
  });
});

// --- API ---

/** Notification écrite directement en base. */
function seedNotification(db: Db, userId: string, overrides: Partial<typeof notifications.$inferInsert> = {}) {
  return db
    .insert(notifications)
    .values({ userId, kind: 'approved', ...overrides })
    .returning()
    .get();
}

describe('GET /api/notifications', () => {
  it('sans session → 401', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode).toBe(401);
  });

  it('ses notifications seulement, les plus récentes d’abord, avec le nombre de non lues', async () => {
    const { db, as } = await setup();
    const { member, owner } = await team(as);
    const old = seedNotification(db, member.user.id, { createdAt: new Date(Date.now() - DAY_MS) });
    const recent = seedNotification(db, member.user.id, { kind: 'available', readAt: new Date() });
    seedNotification(db, owner.user.id);

    const page = (await member.get('/api/notifications')).json<NotificationPage>();
    expect(page).toMatchObject({ page: 1, totalPages: 1, unread: 1 });
    expect(page.results.map((n) => [n.id, n.read])).toEqual([
      [recent.id, true],
      [old.id, false],
    ]);
    // Demande inconnue : texte de repli, pas de lien.
    expect(page.results[1]).toMatchObject({ requestId: null, media: null, body: 'Votre demande a été approuvée.' });
  });

  it('paginée par NOTIFICATIONS_PAGE_SIZE', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    for (let i = 0; i <= NOTIFICATIONS_PAGE_SIZE; i++) seedNotification(db, member.user.id);

    const first = (await member.get('/api/notifications')).json<NotificationPage>();
    expect(first).toMatchObject({ totalPages: 2, unread: NOTIFICATIONS_PAGE_SIZE + 1 });
    expect(first.results).toHaveLength(NOTIFICATIONS_PAGE_SIZE);
    expect((await member.get('/api/notifications?page=2')).json<NotificationPage>().results).toHaveLength(1);
    expect((await member.get('/api/notifications?page=0')).statusCode).toBe(400);
  });
});

describe('POST /api/notifications/read', () => {
  it('marque les siennes ; les ids d’un autre membre sont ignorés', async () => {
    const { db, as } = await setup();
    const { member, owner } = await team(as);
    const mine = seedNotification(db, member.user.id);
    const other = seedNotification(db, member.user.id);
    const theirs = seedNotification(db, owner.user.id);

    const res = await member.post('/api/notifications/read', { ids: [mine.id, theirs.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unread: 1 });
    const readAt = (id: number) => db.select().from(notifications).where(eq(notifications.id, id)).get()?.readAt;
    expect(readAt(mine.id)).toBeInstanceOf(Date);
    expect(readAt(other.id)).toBeNull();
    expect(readAt(theirs.id)).toBeNull();
  });

  it('{ all: true } : toutes les siennes, pas celles des autres', async () => {
    const { db, as } = await setup();
    const { member, owner } = await team(as);
    seedNotification(db, member.user.id);
    seedNotification(db, member.user.id);
    seedNotification(db, owner.user.id);

    expect((await member.post('/api/notifications/read', { all: true })).json()).toEqual({ unread: 0 });
    expect((await owner.get('/api/notifications')).json<NotificationPage>().unread).toBe(1);
  });

  it('corps invalide → 400 ; sans en-tête CSRF → 403', async () => {
    const { app, as } = await setup();
    const member = await as('member');
    expect((await member.post('/api/notifications/read', { ids: [] })).statusCode).toBe(400);
    expect((await member.post('/api/notifications/read', { all: false })).statusCode).toBe(400);
    const { [CSRF_HEADER]: _csrf, ...withoutCsrf } = member.headers;
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: withoutCsrf,
      payload: { all: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

// --- Base ---

describe('notifications en base', () => {
  it('liste et non lues passent par leurs index, sans tri temporaire', async () => {
    const { data, as } = await setup();
    const member = await as('member');
    const service = createNotifications(data, { tmdb: () => ({}) as never });
    const list = queryPlan(data.db, service.listQuery(member.user.id, 1));
    expect(list).toContain('notifications_user_id_created_at_idx');
    expect(list).not.toContain('TEMP B-TREE');
    expect(queryPlan(data.db, service.unreadQuery(member.user.id))).toContain('notifications_unread_idx');
  });

  it('purge : lues de plus de 90 jours seulement', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const old = new Date(Date.now() - NOTIFICATION_RETENTION_MS - DAY_MS);
    const purged = seedNotification(db, member.user.id, { createdAt: old, readAt: old });
    const unreadOld = seedNotification(db, member.user.id, { createdAt: old });
    const readRecent = seedNotification(db, member.user.id, { readAt: new Date() });

    expect(purgeReadNotifications(db, new Date(Date.now() - NOTIFICATION_RETENTION_MS))).toBe(1);
    const left = db
      .select({ id: notifications.id })
      .from(notifications)
      .all()
      .map((n) => n.id);
    expect(left).toEqual([unreadOld.id, readRecent.id]);
    expect(left).not.toContain(purged.id);
  });

  it('le balayage complet purge les notifications lues anciennes', async () => {
    const { app, data, db, as } = await setup();
    const member = await as('member');
    const old = new Date(Date.now() - NOTIFICATION_RETENTION_MS - DAY_MS);
    seedNotification(db, member.user.id, { createdAt: old, readAt: old });

    await createSync(data, { availability: app.availability }).fullScan();
    expect(db.select().from(notifications).all()).toEqual([]);
  });

  it('demande supprimée (membre supprimé) : la notification du gestionnaire reste, sans lien', async () => {
    const { db, as } = await setup();
    const { member, owner } = await team(as);
    const request = await requestMovie(member);
    db.delete(requests).where(eq(requests.id, request.id)).run();

    const [left] = (await owner.get('/api/notifications')).json<NotificationPage>().results;
    expect(left).toMatchObject({ kind: 'requested', requestId: null, body: 'Un membre a demandé un titre.' });
  });
});
