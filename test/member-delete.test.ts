import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/index.ts';
import {
  apiKeys,
  blockedTitles,
  issueComments,
  issues,
  media,
  notifications,
  pushSubscriptions,
  requestEvents,
  requestSeasons,
  requests,
  sessions,
  users,
  watchlist,
} from '../src/server/db/schema.ts';
import { createApiKey } from '../src/server/services/api-keys.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { loginAs, loginAsOwner, trackApps } from './helpers.ts';

const newApp = trackApps();

const del = (app: FastifyInstance, id: string, headers: Record<string, string>) =>
  app.inject({ method: 'DELETE', url: `/api/users/${id}`, headers });

/** Gestionnaire à qui le propriétaire a accordé « Gérer les membres » (le rôle seul ne le donne pas). */
async function loginAsUsersManager(app: FastifyInstance, id: string) {
  const session = await loginAs(app, 'manager', id);
  app.data.db
    .update(users)
    .set({ permissions: { canManageUsers: true } })
    .where(eq(users.id, id))
    .run();
  return session;
}

const exists = (db: Db, id: string) => db.select().from(users).where(eq(users.id, id)).get() !== undefined;

describe('DELETE /api/users/:id : refus', () => {
  it('403 pour le propriétaire, pour soi-même et pour un membre qu’on ne modifierait pas', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const manager = await loginAsUsersManager(app, 'gestionnaire-membres');
    const otherManager = await loginAsUsersManager(app, 'autre-gestionnaire-membres');
    const member = await loginAs(app, 'member');

    const ownerTarget = await del(app, owner.user.id, owner.headers);
    expect(ownerTarget.statusCode).toBe(403);
    expect(ownerTarget.json().error).toMatch(/propriétaire/);
    expect((await del(app, owner.user.id, manager.headers)).statusCode).toBe(403);

    const self = await del(app, manager.user.id, manager.headers);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toMatch(/votre propre compte/);

    // Un gestionnaire ne supprime pas un autre membre qui gère les membres.
    const peer = await del(app, otherManager.user.id, manager.headers);
    expect(peer.statusCode).toBe(403);
    expect(peer.json().error).toMatch(/gère les membres/);

    // Sans le droit « Gérer les membres » : un gestionnaire (rôle seul) comme un membre.
    const plainManager = await loginAs(app, 'manager', 'gestionnaire-simple');
    expect((await del(app, member.user.id, plainManager.headers)).statusCode).toBe(403);
    expect((await del(app, otherManager.user.id, member.headers)).statusCode).toBe(403);
    expect((await del(app, member.user.id, member.headers)).statusCode).toBe(403);

    for (const id of [owner.user.id, manager.user.id, otherManager.user.id, member.user.id, plainManager.user.id])
      expect(exists(app.data.db, id)).toBe(true);
  });

  it('401 sans session, 404 pour un membre inconnu', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    expect((await app.inject({ method: 'DELETE', url: '/api/users/x', headers: CSRF_HEADERS })).statusCode).toBe(401);
    const res = await del(app, 'inconnu', owner.headers);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Membre introuvable');
  });
});

describe('DELETE /api/users/:id', () => {
  it('204 : le propriétaire supprime un gestionnaire, qui gère les membres ou non', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const manager = await loginAsUsersManager(app, 'gestionnaire-membres');
    const plainManager = await loginAs(app, 'manager', 'gestionnaire-simple');
    const member = await loginAs(app, 'member');

    expect((await del(app, member.user.id, manager.headers)).statusCode).toBe(204);
    expect(exists(app.data.db, member.user.id)).toBe(false);
    // Qui gère les membres supprime un gestionnaire qui ne les gère pas.
    expect((await del(app, plainManager.user.id, manager.headers)).statusCode).toBe(204);
    expect((await del(app, manager.user.id, owner.headers)).statusCode).toBe(204);
    expect(exists(app.data.db, manager.user.id)).toBe(false);
    expect(exists(app.data.db, plainManager.user.id)).toBe(false);
    expect((await del(app, member.user.id, owner.headers)).statusCode).toBe(404);
  });

  it('déconnecte le membre supprimé', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const victim = await loginAs(app, 'manager', 'victime');
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: victim.headers })).statusCode).toBe(200);
    expect((await del(app, victim.user.id, owner.headers)).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: victim.headers })).statusCode).toBe(401);
  });

  it('supprime ses données en cascade et laisse sans auteur ce qu’il a décidé, bloqué, résolu ou commenté', async () => {
    const app = await newApp();
    const { db } = app.data;
    const owner = await loginAsOwner(app);
    const other = await loginAs(app, 'member', 'autre');
    const victim = await loginAs(app, 'manager', 'victime');
    const v = victim.user.id;
    const o = other.user.id;

    const film = db.insert(media).values({ type: 'movie', tmdbId: 100, statusUpdatedAt: new Date() }).returning().get();
    const serie = db.insert(media).values({ type: 'tv', tmdbId: 101, statusUpdatedAt: new Date() }).returning().get();

    // Sa demande (saisons, frise), et une demande d'autrui qu'il a décidée et créée à sa place.
    const own = db
      .insert(requests)
      .values({ mediaId: serie.id, userId: v, status: 'pending', createdBy: v })
      .returning()
      .get();
    db.insert(requestSeasons)
      .values([
        { requestId: own.id, seasonNumber: 1 },
        { requestId: own.id, seasonNumber: 2 },
      ])
      .run();
    db.insert(requestEvents).values({ requestId: own.id, type: 'requested', actorId: v }).run();
    const decided = db
      .insert(requests)
      .values({ mediaId: film.id, userId: o, status: 'approved', decidedBy: v, createdBy: v })
      .returning()
      .get();
    db.insert(requestEvents).values({ requestId: decided.id, type: 'approved', actorId: v }).run();
    db.insert(requestEvents).values({ requestId: decided.id, type: 'requested', actorId: o }).run();

    // Notifications : la sienne (sur sa demande) et celle d'autrui qui renvoie à sa demande.
    db.insert(notifications).values({ userId: v, kind: 'approved', requestId: own.id }).run();
    const theirs = db
      .insert(notifications)
      .values({ userId: o, kind: 'approved', requestId: own.id })
      .returning()
      .get();

    // Signalements : le sien (avec commentaire) ; un d'autrui qu'il a résolu et commenté.
    const ownIssue = db
      .insert(issues)
      .values({ mediaId: film.id, userId: v, type: 'video', message: 'Image saccadée' })
      .returning()
      .get();
    db.insert(issueComments).values({ issueId: ownIssue.id, userId: v, message: 'Précision' }).run();
    const resolved = db
      .insert(issues)
      .values({
        mediaId: film.id,
        userId: o,
        type: 'audio',
        message: 'Son décalé',
        status: 'resolved',
        resolvedBy: v,
        resolvedAt: new Date(),
      })
      .returning()
      .get();
    db.insert(issueComments).values({ issueId: resolved.id, userId: v, message: 'Corrigé' }).run();
    db.insert(issueComments).values({ issueId: resolved.id, userId: o, message: 'Merci' }).run();

    db.insert(watchlist).values({ userId: v, mediaType: 'movie', tmdbId: 7 }).run();
    db.insert(pushSubscriptions).values({ userId: v, endpoint: 'https://push.test/v', p256dh: 'p', auth: 'a' }).run();
    createApiKey(db, victim.user, 'Clé de la victime');
    db.insert(blockedTitles).values({ mediaType: 'movie', tmdbId: 9, title: 'Bloqué', blockedBy: v }).run();

    expect(db.select({ n: count() }).from(sessions).where(eq(sessions.userId, v)).get()?.n).toBe(1);
    expect((await del(app, v, owner.headers)).statusCode).toBe(204);
    expect(exists(db, v)).toBe(false);

    // Disparu avec lui.
    const total = (query: { get: () => { n: number } | undefined }) => query.get()?.n;
    expect(total(db.select({ n: count() }).from(sessions).where(eq(sessions.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(requests).where(eq(requests.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(requestSeasons).where(eq(requestSeasons.requestId, own.id)))).toBe(0);
    expect(total(db.select({ n: count() }).from(requestEvents).where(eq(requestEvents.requestId, own.id)))).toBe(0);
    expect(total(db.select({ n: count() }).from(notifications).where(eq(notifications.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(issues).where(eq(issues.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(issueComments).where(eq(issueComments.issueId, ownIssue.id)))).toBe(0);
    expect(total(db.select({ n: count() }).from(watchlist).where(eq(watchlist.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, v)))).toBe(0);
    expect(total(db.select({ n: count() }).from(apiKeys).where(eq(apiKeys.createdBy, v)))).toBe(0);

    // Reste, sans auteur.
    expect(db.select().from(requests).where(eq(requests.id, decided.id)).get()).toMatchObject({
      userId: o,
      decidedBy: null,
      createdBy: null,
    });
    const events = db.select().from(requestEvents).where(eq(requestEvents.requestId, decided.id)).all();
    expect(events.map((e) => [e.type, e.actorId]).sort()).toEqual([
      ['approved', null],
      ['requested', o],
    ]);
    expect(db.select().from(notifications).where(eq(notifications.id, theirs.id)).get()).toMatchObject({
      userId: o,
      requestId: null,
    });
    expect(db.select().from(issues).where(eq(issues.id, resolved.id)).get()).toMatchObject({
      userId: o,
      status: 'resolved',
      resolvedBy: null,
    });
    const comments = db.select().from(issueComments).where(eq(issueComments.issueId, resolved.id)).all();
    expect(comments.map((c) => [c.message, c.userId]).sort()).toEqual([
      ['Corrigé', null],
      ['Merci', o],
    ]);
    expect(db.select().from(blockedTitles).get()).toMatchObject({ title: 'Bloqué', blockedBy: null });
    expect(exists(db, o)).toBe(true);
  });
});
