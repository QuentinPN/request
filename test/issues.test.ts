import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, openDataDir } from '../src/server/db/index.ts';
import { issues, media, notifications, requests, seasons, users } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import {
  ISSUES_PAGE_SIZE,
  type IssueCounts,
  type IssueCreateInput,
  type IssueDetail,
  type IssuePage,
} from '../src/shared/issues.ts';
import type { NotificationPage } from '../src/shared/notifications.ts';
import type { Role } from '../src/shared/roles.ts';
import { loginAs, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
}

/**
 * Appli sur un faux TMDB (Matrix). Aucun service Emby/Radarr/Sonarr n'est réglé : le statut de bibliothèque des titres
 * est celui qu'on écrit dans `media` (film 603 disponible, série 1399 partielle, film 700 pas dans la bibliothèque).
 */
async function setup() {
  const tmdb = await startServer({ 'GET /movie/603': matrix });
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url } });
  cleanups.push(() => app.close());
  const seed = (id: number, type: 'movie' | 'tv', tmdbId: number, status: 'available' | 'partial' | null) =>
    db.insert(media).values({ id, type, tmdbId, status, statusUpdatedAt: new Date() }).run();
  seed(1, 'movie', 603, 'available');
  seed(2, 'tv', 1399, 'partial');
  seed(3, 'movie', 700, null);
  const as = async (role: Role, id?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
    };
  };
  return { app, db, as };
}

const report = (extra: Partial<IssueCreateInput> = {}): IssueCreateInput => ({
  type: 'subtitles',
  mediaType: 'movie',
  tmdbId: 603,
  message: 'Les sous-titres sont décalés',
  ...extra,
});

const kindsOf = (db: Db, userId: string) =>
  db
    .select({ kind: notifications.kind })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .all()
    .map((n) => n.kind);

const create = async (actor: Actor, input = report()) => (await actor.post('/api/issues', input)).json<IssueDetail>();

describe('création', () => {
  it('un membre signale un problème sur un titre disponible', async () => {
    const { as } = await setup();
    const member = await as('member');
    const res = await member.post('/api/issues', report());

    expect(res.statusCode).toBe(201);
    expect(res.json<IssueDetail>()).toMatchObject({
      type: 'subtitles',
      status: 'open',
      media: { type: 'movie', tmdbId: 603 },
      seasonNumber: null,
      episodeNumber: null,
      message: 'Les sous-titres sont décalés',
      author: { id: member.user.id },
      resolvedBy: null,
      resolvedAt: null,
      title: 'Matrix',
      comments: [],
    });
  });

  it('un titre pas dans la bibliothèque (ou inconnu) → 409', async () => {
    const { as } = await setup();
    const member = await as('member');
    expect((await member.post('/api/issues', report({ tmdbId: 700 }))).statusCode).toBe(409);
    expect((await member.post('/api/issues', report({ tmdbId: 999 }))).statusCode).toBe(409);
  });

  it('une série partielle dont des saisons sont demandées reste signalable (saison et épisode facultatifs)', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    // Une demande en cours fait afficher « demandé » : seul le statut de bibliothèque compte.
    db.insert(requests).values({ mediaId: 2, userId: member.user.id, status: 'pending' }).run();
    const res = await member.post(
      '/api/issues',
      report({ mediaType: 'tv', tmdbId: 1399, seasonNumber: 2, episodeNumber: 5, type: 'audio' }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json<IssueDetail>()).toMatchObject({ type: 'audio', seasonNumber: 2, episodeNumber: 5 });
    expect((await member.post('/api/issues', report({ mediaType: 'tv', tmdbId: 1399 }))).statusCode).toBe(201);
  });

  it.each<[string, Partial<IssueCreateInput>]>([
    ['saison sur un film', { seasonNumber: 1 }],
    ['épisode sans saison', { mediaType: 'tv', tmdbId: 1399, episodeNumber: 3 }],
    ['message vide', { message: '   ' }],
    ['type inconnu', { type: 'son' as never }],
    ['saison hors borne', { mediaType: 'tv', tmdbId: 1399, seasonNumber: 101 }],
    ['épisode hors borne', { mediaType: 'tv', tmdbId: 1399, seasonNumber: 1, episodeNumber: 1001 }],
  ])('entrée invalide (%s) → 400', async (_name, extra) => {
    const { as } = await setup();
    const member = await as('member');
    expect((await member.post('/api/issues', report(extra))).statusCode).toBe(400);
  });

  it('une saison absente des saisons connues du titre → 400 ; sans saisons connues, la borne suffit', async () => {
    const { db, as } = await setup();
    const member = await as('member');
    const tv = (seasonNumber: number) => report({ mediaType: 'tv', tmdbId: 1399, seasonNumber });
    expect((await member.post('/api/issues', tv(9))).statusCode).toBe(201);
    db.insert(seasons)
      .values([1, 2].map((seasonNumber) => ({ mediaId: 2, seasonNumber, status: 'available' as const })))
      .run();
    const res = await member.post('/api/issues', tv(9));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('saison 9');
    expect((await member.post('/api/issues', tv(2))).statusCode).toBe(201);
  });

  it('sans session → 401', async () => {
    const { app } = await setup();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/issues' });
    expect(res.statusCode).toBe(401);
  });
});

describe('droits de lecture', () => {
  it('un membre ne voit que les siens ; un gestionnaire voit tout, avec les totaux de son périmètre', async () => {
    const { as } = await setup();
    const [ann, bob, manager] = [await as('member', 'ann'), await as('member', 'bob'), await as('manager')];
    const mine = await create(ann);
    const theirs = await create(bob, report({ type: 'video' }));

    const annList = (await ann.get('/api/issues')).json<IssuePage>();
    expect(annList.results.map((i) => i.id)).toEqual([mine.id]);
    expect(annList.totals).toEqual({ open: 1, resolved: 0 });
    expect((await ann.get(`/api/issues/${mine.id}`)).statusCode).toBe(200);
    // Le signalement d'un autre n'existe pas pour lui.
    expect((await ann.get(`/api/issues/${theirs.id}`)).statusCode).toBe(404);
    expect((await ann.post(`/api/issues/${theirs.id}/comments`, { message: 'Moi aussi' })).statusCode).toBe(404);
    expect((await ann.post(`/api/issues/${theirs.id}/resolve`)).statusCode).toBe(404);

    const all = (await manager.get('/api/issues')).json<IssuePage>();
    expect(all.results.map((i) => i.id)).toEqual([theirs.id, mine.id]);
    expect(all.totals).toEqual({ open: 2, resolved: 0 });
    expect((await manager.get('/api/issues/counts')).json<IssueCounts>()).toEqual({ open: 2 });
    expect((await ann.get('/api/issues/counts')).json<IssueCounts>()).toEqual({ open: 1 });
  });

  it('filtre ouvert / résolu et pagination', async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const first = await create(manager);
    for (let i = 0; i < ISSUES_PAGE_SIZE; i++) await create(manager);
    await manager.post(`/api/issues/${first.id}/resolve`);

    const open = (await manager.get('/api/issues?status=open')).json<IssuePage>();
    expect(open).toMatchObject({ page: 1, totalPages: 1, totals: { open: ISSUES_PAGE_SIZE, resolved: 1 } });
    expect(open.results).toHaveLength(ISSUES_PAGE_SIZE);
    const resolved = (await manager.get('/api/issues?status=resolved')).json<IssuePage>();
    expect(resolved.results.map((i) => i.id)).toEqual([first.id]);
    const everything = (await manager.get('/api/issues?page=2')).json<IssuePage>();
    expect(everything).toMatchObject({ page: 2, totalPages: 2 });
    expect(everything.results).toHaveLength(1);
    expect((await manager.get('/api/issues?status=autre')).statusCode).toBe(400);
    expect(db.select().from(issues).all()).toHaveLength(ISSUES_PAGE_SIZE + 1);
  });
});

describe('fil de commentaires', () => {
  it('l’auteur et un gestionnaire commentent, dans l’ordre', async () => {
    const { as } = await setup();
    const [member, manager] = [await as('member'), await as('manager')];
    const issue = await create(member);
    await manager.post(`/api/issues/${issue.id}/comments`, { message: 'Je regarde ça' });
    const res = await member.post(`/api/issues/${issue.id}/comments`, { message: 'Merci' });

    expect(res.statusCode).toBe(200);
    expect(res.json<IssueDetail>().comments.map((c) => [c.author?.id, c.message])).toEqual([
      [manager.user.id, 'Je regarde ça'],
      [member.user.id, 'Merci'],
    ]);
    expect((await member.post(`/api/issues/${issue.id}/comments`, { message: ' ' })).statusCode).toBe(400);
  });
});

describe('résolution', () => {
  it('l’auteur résout le sien, mais ne le rouvre pas ; un gestionnaire le rouvre', async () => {
    const { as } = await setup();
    const [member, manager] = [await as('member'), await as('manager')];
    const issue = await create(member);

    const resolved = (await member.post(`/api/issues/${issue.id}/resolve`)).json<IssueDetail>();
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: { id: member.user.id } });
    expect(resolved.resolvedAt).not.toBeNull();
    expect((await member.post(`/api/issues/${issue.id}/resolve`)).statusCode).toBe(409);
    expect((await member.post(`/api/issues/${issue.id}/reopen`)).statusCode).toBe(403);

    const reopened = (await manager.post(`/api/issues/${issue.id}/reopen`)).json<IssueDetail>();
    expect(reopened).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null });
    expect((await manager.post(`/api/issues/${issue.id}/reopen`)).statusCode).toBe(409);
    expect((await manager.post(`/api/issues/${issue.id}/resolve`)).json<IssueDetail>().resolvedBy?.id).toBe(
      manager.user.id,
    );
  });

  it('identifiant inconnu ou invalide : 404 et 400', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    expect((await manager.get('/api/issues/999')).statusCode).toBe(404);
    expect((await manager.post('/api/issues/999/resolve')).statusCode).toBe(404);
    expect((await manager.get('/api/issues/abc')).statusCode).toBe(400);
  });
});

describe('notifications', () => {
  it('nouveau signalement : les gestionnaires sont prévenus, pas l’auteur ; le titre est lié', async () => {
    const { db, as } = await setup();
    const [member, manager, owner] = [await as('member'), await as('manager'), await as('owner')];
    const issue = await create(member);

    expect(kindsOf(db, manager.user.id)).toEqual(['issue_created']);
    expect(kindsOf(db, owner.user.id)).toEqual(['issue_created']);
    expect(kindsOf(db, member.user.id)).toEqual([]);
    const [created] = (await manager.get('/api/notifications')).json<NotificationPage>().results;
    expect(created).toMatchObject({
      kind: 'issue_created',
      title: 'Nouveau signalement',
      body: 'Un problème a été signalé sur « Matrix ».',
      issueId: issue.id,
      requestId: null,
      media: { type: 'movie', tmdbId: 603 },
    });
  });

  it('un gestionnaire qui signale ne se prévient pas lui-même, mais prévient les autres', async () => {
    const { db, as } = await setup();
    const [manager, owner] = [await as('manager'), await as('owner')];
    await create(manager);

    expect(kindsOf(db, manager.user.id)).toEqual([]);
    expect(kindsOf(db, owner.user.id)).toEqual(['issue_created']);
  });

  it('commentaire : l’auteur et les participants, jamais l’auteur du commentaire', async () => {
    const { db, as } = await setup();
    const [member, manager, owner] = [await as('member'), await as('manager'), await as('owner')];
    const issue = await create(member);
    const clear = () => db.delete(notifications).run();
    clear();

    await manager.post(`/api/issues/${issue.id}/comments`, { message: 'Je regarde' });
    expect(kindsOf(db, member.user.id)).toEqual(['issue_commented']);
    // Le propriétaire n'a pas encore pris part : pas de notification.
    expect(kindsOf(db, owner.user.id)).toEqual([]);
    expect(kindsOf(db, manager.user.id)).toEqual([]);

    clear();
    await member.post(`/api/issues/${issue.id}/comments`, { message: 'Merci' });
    expect(kindsOf(db, manager.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, member.user.id)).toEqual([]);

    clear();
    await owner.post(`/api/issues/${issue.id}/comments`, { message: 'Corrigé côté serveur' });
    expect(kindsOf(db, member.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, manager.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, owner.user.id)).toEqual([]);
  });

  it('commentaire de l’auteur : les gestionnaires déjà intervenus, à défaut tous ; un ex-gestionnaire est exclu', async () => {
    const { db, as } = await setup();
    const [member, manager, owner] = [await as('member'), await as('manager'), await as('owner')];
    const issue = await create(member);
    db.delete(notifications).run();

    await member.post(`/api/issues/${issue.id}/comments`, { message: 'Des nouvelles ?' });
    expect(kindsOf(db, manager.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, owner.user.id)).toEqual(['issue_commented']);

    await manager.post(`/api/issues/${issue.id}/comments`, { message: 'Je regarde' });
    db.delete(notifications).run();
    await member.post(`/api/issues/${issue.id}/comments`, { message: 'Merci' });
    expect(kindsOf(db, manager.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, owner.user.id)).toEqual([]);

    db.update(users).set({ role: 'member' }).where(eq(users.id, manager.user.id)).run();
    db.delete(notifications).run();
    await owner.post(`/api/issues/${issue.id}/comments`, { message: 'Corrigé' });
    expect(kindsOf(db, member.user.id)).toEqual(['issue_commented']);
    expect(kindsOf(db, manager.user.id)).toEqual([]);
  });

  it('résolu puis rouvert : l’auteur est prévenu ; résoudre le sien ne prévient personne', async () => {
    const { db, as } = await setup();
    const [member, manager] = [await as('member'), await as('manager')];
    const issue = await create(member);
    db.delete(notifications).run();

    await manager.post(`/api/issues/${issue.id}/resolve`);
    await manager.post(`/api/issues/${issue.id}/reopen`);
    expect(kindsOf(db, member.user.id)).toEqual(['issue_resolved', 'issue_reopened']);
    expect(kindsOf(db, manager.user.id)).toEqual([]);

    db.delete(notifications).run();
    await member.post(`/api/issues/${issue.id}/resolve`);
    expect(db.select().from(notifications).all()).toEqual([]);
  });

  it('transition refusée (409) : aucune notification', async () => {
    const { db, as } = await setup();
    const [member, manager] = [await as('member'), await as('manager')];
    const issue = await create(member);
    await manager.post(`/api/issues/${issue.id}/resolve`);
    db.delete(notifications).run();

    expect((await manager.post(`/api/issues/${issue.id}/resolve`)).statusCode).toBe(409);
    expect(db.select().from(notifications).all()).toEqual([]);
  });

  it('un signalement supprimé laisse la notification sans titre ni lien', async () => {
    const { db, as } = await setup();
    const [member, manager] = [await as('member'), await as('manager')];
    const issue = await create(member);
    db.delete(issues).where(eq(issues.id, issue.id)).run();

    const [left] = (await manager.get('/api/notifications')).json<NotificationPage>().results;
    expect(left).toMatchObject({ issueId: null, media: null, body: 'Un problème a été signalé sur un titre.' });
  });
});
