import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { eq, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Db, migrationsFolder, openDataDir, openDb } from '../src/server/db/index.ts';
import { issues, media, notifications, users } from '../src/server/db/schema.ts';
import { notifyIssueEvent } from '../src/server/services/notifications.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { getUser, importFromEmby, upsertFromEmby } from '../src/server/services/users.ts';
import { CSRF_HEADERS, type Member, type MemberOption } from '../src/shared/auth.ts';
import type { RequestDetail } from '../src/shared/requests.ts';
import {
  autoApproves,
  type Capabilities,
  capabilitiesOf,
  memberEditRefusal,
  type PermissionHolder,
  type PermissionOverrides,
  permissionKeys,
  permissionOverridesOf,
  permissionOverridesSchema,
  type Role,
  requestRefusal,
  rolePermissions,
  roles,
} from '../src/shared/roles.ts';
import { status } from './fake-server.ts';
import authenticateFixture from './fixtures/emby/authenticate.json';
import usersFixture from './fixtures/emby/users.json';
import {
  addArrServer,
  loginAs,
  loginAsOwner,
  SLOW_TEST,
  trackFakeServers,
  trackTempDirs,
  truncatedMigrations,
} from './helpers.ts';

// Lot 8.4 : droits fins par membre (préréglage du rôle + remplacements), garde contre l'escalade, droits par défaut,
// édition en masse.

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const holder = (role: Role, permissions: PermissionOverrides | null = null): PermissionHolder => ({
  role,
  permissions,
});
const caps = (role: Role, permissions: PermissionOverrides | null = null): Capabilities =>
  capabilitiesOf(holder(role, permissions));
const setPermissions = (db: Db, id: string, permissions: PermissionOverrides | null) =>
  db.update(users).set({ permissions }).where(eq(users.id, id)).run();

describe('dérivation des droits', () => {
  it('préréglage de chaque rôle, puis remplacements ; le propriétaire a tout', () => {
    for (const role of roles) {
      // Sans remplacement : exactement le préréglage.
      expect(caps(role)).toMatchObject(rolePermissions(role));
    }
    expect(caps('member', { autoApproveTv: true, canRequestMovies: false })).toMatchObject({
      autoApproveTv: true,
      autoApproveMovies: false,
      canRequestMovies: false,
      canRequestTv: true,
    });
    expect(caps('manager', { canViewStats: false })).toMatchObject({ canViewStats: false, canManageRequests: true });
    // Hors quotas reste lié au rôle, quels que soient les remplacements.
    expect(caps('manager', { canManageRequests: false }).quotaExempt).toBe(true);
    expect(caps('member', { canManageRequests: true }).quotaExempt).toBe(false);
    const owner = caps('owner', { canManageUsers: false, canRequestMovies: false });
    expect(permissionKeys.every((key) => owner[key])).toBe(true);
    expect(owner.isOwner).toBe(true);
    // Suivre ses demandes : toujours, même sans droit de demander.
    expect(caps('member', { canRequestMovies: false, canRequestTv: false }).canRequest).toBe(true);
  });

  it('enregistre seulement l’écart au préréglage, `null` sans écart', () => {
    expect(permissionOverridesOf('member', rolePermissions('member'))).toBeNull();
    expect(permissionOverridesOf('member', { ...rolePermissions('member'), canViewStats: true })).toEqual({
      canViewStats: true,
    });
    expect(permissionOverridesOf('manager', { canViewStats: true, canManageIssues: false })).toEqual({
      canManageIssues: false,
    });
  });

  it('ignore à la lecture une clé inconnue, refuse une valeur non booléenne', () => {
    expect(permissionOverridesSchema.parse({ canViewStats: true, inconnu: true })).toEqual({ canViewStats: true });
    expect(permissionOverridesSchema.safeParse({ canViewStats: 'oui' }).success).toBe(false);
    const db = openDb(':memory:');
    upsertFromEmby(db, { id: 'a', name: 'A', avatar: null, isEmbyAdmin: false });
    db.$client.prepare(`update users set permissions = '{"canViewStats":true,"inconnu":1}' where id = 'a'`).run();
    expect(getUser(db, 'a')?.permissions).toEqual({ canViewStats: true });
    // Hors schéma : droits du rôle (journalisé), sans faire échouer la lecture.
    db.$client.prepare(`update users set permissions = '{"canViewStats":"oui"}' where id = 'a'`).run();
    expect(getUser(db, 'a')?.permissions).toBeNull();
    expect(() => db.$client.prepare(`update users set permissions = '[]' where id = 'a'`).run()).toThrow(/CHECK/);
  });

  it('demande permise selon le type et la 4K ; approbation automatique par type, 4K à part', () => {
    expect(requestRefusal(caps('member'), { type: 'movie', is4k: true })).toBeNull();
    expect(requestRefusal(caps('member', { canRequestMovies: false }), { type: 'movie', is4k: false })).toMatch(
      /films/,
    );
    expect(requestRefusal(caps('member', { canRequestMovies: false }), { type: 'tv', is4k: false })).toBeNull();
    expect(requestRefusal(caps('member', { canRequestTv: false }), { type: 'tv', is4k: true })).toMatch(/séries/);
    expect(requestRefusal(caps('member', { canRequest4k: false }), { type: 'tv', is4k: true })).toMatch(/4K/);
    const split = caps('member', { autoApproveMovies: true, autoApprove4k: false });
    expect(autoApproves(split, { type: 'movie', is4k: false })).toBe(true);
    expect(autoApproves(split, { type: 'tv', is4k: false })).toBe(false);
    expect(autoApproves(split, { type: 'movie', is4k: true })).toBe(false);
  });
});

describe('garde contre l’escalade', () => {
  const usersManager = caps('member', { canManageUsers: true, canViewStats: true });
  const fullManager = caps('manager', { canManageUsers: true });
  const member = holder('member');

  it('le propriétaire modifie tout membre, jamais un propriétaire', () => {
    expect(memberEditRefusal(caps('owner'), member, holder('manager', { canManageUsers: true }))).toBeNull();
    expect(memberEditRefusal(caps('owner'), holder('owner'), holder('owner'))).toMatch(/propriétaire/);
  });

  it('sans « Gérer les membres » : refusé', () => {
    expect(memberEditRefusal(caps('manager'), member, member)).toBe('Accès refusé');
  });

  it('ne modifie ni un membre qui gère les membres (lui compris) ni le propriétaire', () => {
    expect(memberEditRefusal(usersManager, holder('member', { canManageUsers: true }), member)).toMatch(
      /Seul le propriétaire/,
    );
    expect(memberEditRefusal(usersManager, holder('owner'), holder('owner'))).toMatch(/propriétaire/);
  });

  it('accorde seulement ce qu’il a, jamais « Gérer les membres »', () => {
    expect(memberEditRefusal(usersManager, member, holder('member', { canViewStats: true }))).toBeNull();
    expect(memberEditRefusal(usersManager, member, holder('member', { canManageIssues: true }))).toMatch(
      /Gérer les signalements/,
    );
    expect(memberEditRefusal(fullManager, member, holder('member', { canManageUsers: true }))).toMatch(
      /Gérer les membres/,
    );
  });

  it('un changement de rôle compte comme une attribution', () => {
    // « Approbation auto » donne l'approbation automatique, qu'il n'a pas.
    expect(memberEditRefusal(usersManager, member, holder('auto_approve'))).toMatch(/Approbation automatique/);
    expect(memberEditRefusal(fullManager, member, holder('auto_approve'))).toBeNull();
  });

  it('rôle Gestionnaire : seulement avec tous ses droits', () => {
    expect(memberEditRefusal(usersManager, member, holder('manager'))).toMatch(/tous les droits d’un gestionnaire/);
    expect(memberEditRefusal(fullManager, member, holder('manager'))).toBeNull();
    // Même en retirant les droits qu'il n'a pas : le rôle reste réservé.
    const stripped = caps('member', { canManageUsers: true, canManageRequests: true });
    expect(memberEditRefusal(stripped, member, holder('manager', { canManageIssues: false }))).toMatch(/gestionnaire/);
  });

  it('retirer un droit qu’il n’a pas reste permis', () => {
    const target = holder('member', { canManageIssues: true });
    expect(memberEditRefusal(usersManager, target, member)).toBeNull();
  });
});

// --- Routes ---

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const matrix = { id: 603, title: 'Matrix', release_date: '1999-03-30', overview: 'Un pirate.', poster_path: '/m.jpg' };
const got = {
  id: 1399,
  name: 'Game of Thrones',
  first_air_date: '2011-04-17',
  overview: 'Trônes.',
  seasons: [{ season_number: 1, episode_count: 10, air_date: '2011-04-17' }],
  external_ids: { tvdb_id: 121361 },
};
const radarrRoutes = {
  'GET /api/v3/movie': [],
  'GET /api/v3/queue': { totalRecords: 0, records: [] },
  'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'Matrix', tmdbId: 603, hasFile: false, monitored: false },
  'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
  'GET /api/v3/qualityprofile': [{ id: 1, name: 'HD' }],
  'GET /api/v3/rootfolder': [{ id: 1, path: '/films', freeSpace: 1 }],
};

type Actor = {
  user: { id: string; name: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  post: (url: string, payload?: object) => Promise<LightMyRequestResponse>;
  put: (url: string, payload: object) => Promise<LightMyRequestResponse>;
};

async function setup() {
  const tmdb = await startServer({ 'GET /movie/603': matrix, 'GET /tv/1399': got });
  const radarr = await startServer(radarrRoutes);
  const radarr4k = await startServer(radarrRoutes);
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  addArrServer(data, { type: 'radarr', url: radarr.url, rootFolderPath: '/films' });
  addArrServer(data, { type: 'radarr', url: radarr4k.url, is4k: true, rootFolderPath: '/films' });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string, permissions: PermissionOverrides | null = null): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    if (permissions) setPermissions(data.db, user.id, permissions);
    const send = (method: 'POST' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload && { payload }) });
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, payload) => send('POST', url, payload),
      put: (url, payload) => send('PUT', url, payload),
    };
  };
  return { app, db: data.db, as };
}

const MOVIE = { type: 'movie', tmdbId: 603 };
const TV = { type: 'tv', tmdbId: 1399, seasons: [1] };

describe('demandes : droits du type, de la 4K et approbation automatique', () => {
  it('403 en français sans le droit du type ou de la 4K, pour soi ou pour un autre', SLOW_TEST, async () => {
    const { as } = await setup();
    const noMovies = await as('member', 'sans-films', { canRequestMovies: false });
    const noTv = await as('member', 'sans-series', { canRequestTv: false });
    const no4k = await as('member', 'sans-4k', { canRequest4k: false });

    const movie = await noMovies.post('/api/requests', MOVIE);
    expect(movie.statusCode).toBe(403);
    expect(movie.json().error).toBe('Pas de droit de demander des films');
    expect((await noTv.post('/api/requests', TV)).json().error).toBe('Pas de droit de demander des séries');
    expect((await no4k.post('/api/requests', { ...MOVIE, is4k: true })).json().error).toBe(
      'Pas de droit de demander en 4K',
    );
    // Les autres types restent ouverts, et ses demandes restent lisibles.
    expect((await noMovies.post('/api/requests', TV)).statusCode).toBe(201);
    expect((await noMovies.get('/api/requests')).statusCode).toBe(200);

    // Pour un autre membre : ses droits à lui s'appliquent.
    const manager = await as('manager');
    const onBehalf = await manager.post('/api/requests', { ...MOVIE, forUserId: noMovies.user.id });
    expect(onBehalf.statusCode).toBe(403);
    expect(onBehalf.json().error).toBe(`Pas de droit de demander des films (${noMovies.user.name})`);
  });

  it('approbation automatique séparée : films, séries, 4K', SLOW_TEST, async () => {
    const { db, as } = await setup();
    const manager = await as('manager');
    const moviesOnly = await as('member', 'films-auto', { autoApproveMovies: true });
    const movie = (await moviesOnly.post('/api/requests', MOVIE)).json<RequestDetail>();
    expect(movie.status).toBe('sent');
    const series = (await moviesOnly.post('/api/requests', TV)).json<RequestDetail>();
    expect(series.status).toBe('pending');
    const movie4k = (await moviesOnly.post('/api/requests', { ...MOVIE, is4k: true })).json<RequestDetail>();
    expect(movie4k.status).toBe('pending');

    // Les gestionnaires sont prévenus des seules demandes qui attendent (même règle, `autoApproves`).
    const requested = db
      .select({ requestId: notifications.requestId })
      .from(notifications)
      .where(eq(notifications.userId, manager.user.id))
      .all()
      .map((n) => n.requestId);
    expect(requested.sort()).toEqual([series.id, movie4k.id].sort());
  });

  it('approbation automatique 4K seule : la 4K part, la version normale attend', SLOW_TEST, async () => {
    const { as } = await setup();
    const only4k = await as('member', '4k-auto', { autoApprove4k: true });
    expect((await only4k.post('/api/requests', { ...MOVIE, is4k: true })).json<RequestDetail>().status).toBe('sent');
    expect((await only4k.post('/api/requests', MOVIE)).json<RequestDetail>().status).toBe('pending');
  });

  it('« Hors quota » au cas par cas : le droit, pas le rôle', SLOW_TEST, async () => {
    const { as } = await setup();
    const member = await as('member', 'hors-quota', { canRequestQuotaExempt: true });
    expect((await member.post('/api/requests', { ...MOVIE, quotaExempt: true })).statusCode).toBe(201);
    const manager = await as('manager', 'gestionnaire-sans', { canRequestQuotaExempt: false });
    const refused = await manager.post('/api/requests', { ...TV, quotaExempt: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('Vous ne pouvez pas mettre une demande hors quota');
  });
});

describe('routes de gestion : droits effectifs', () => {
  it('accordés à un membre, retirés à un gestionnaire', SLOW_TEST, async () => {
    const { as } = await setup();
    const stats = await as('member', 'stats', { canViewStats: true, canManageBlocklist: true });
    expect((await stats.get('/api/stats')).statusCode).toBe(200);
    expect((await stats.get('/api/blocklist')).statusCode).toBe(200);
    const manager = await as('manager', 'gestionnaire-limite', { canViewStats: false, canManageRequests: false });
    expect((await manager.get('/api/stats')).statusCode).toBe(403);
    const member = await as('member');
    const request = (await member.post('/api/requests', MOVIE)).json<RequestDetail>();
    expect((await manager.post(`/api/requests/${request.id}/decline`, { reason: 'non' })).statusCode).toBe(403);
    const approver = await as('member', 'approbateur', { canManageRequests: true });
    expect((await approver.post(`/api/requests/${request.id}/decline`, { reason: 'non' })).statusCode).toBe(200);
  });

  it('notifications « à traiter » : d’après les droits effectifs, pas le rôle', SLOW_TEST, async () => {
    const { db, as } = await setup();
    const silenced = await as('manager', 'gestionnaire-muet', { canManageRequests: false, canManageIssues: false });
    const approver = await as('member', 'approbateur', { canManageRequests: true });
    const moderator = await as('member', 'moderateur', { canManageIssues: true });
    const member = await as('member');
    const request = (await member.post('/api/requests', MOVIE)).json<RequestDetail>();
    const recipientsOf = (where: SQL) =>
      db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(where)
        .all()
        .map((n) => n.userId);
    expect(recipientsOf(eq(notifications.requestId, request.id))).toEqual([approver.user.id]);

    // Signalement : mêmes règles pour « Gérer les signalements » (droit vérifié aussi à la lecture).
    const mediaId = db.select({ id: media.id }).from(media).get()?.id ?? 0;
    const issue = db
      .insert(issues)
      .values({ mediaId, userId: member.user.id, type: 'video', message: 'Image figée' })
      .returning()
      .get();
    db.transaction((tx) =>
      notifyIssueEvent(tx, { issueId: issue.id, kind: 'issue_created', actorId: member.user.id, at: new Date() }),
    );
    expect(recipientsOf(eq(notifications.issueId, issue.id))).toEqual([moderator.user.id]);
    expect((await moderator.get(`/api/issues/${issue.id}`)).statusCode).toBe(200);
    expect((await silenced.get(`/api/issues/${issue.id}`)).statusCode).toBe(404);
  });

  it('liste des membres : demander pour un autre suffit, avec les droits propres de chacun', SLOW_TEST, async () => {
    const { as } = await setup();
    const onBehalf = await as('member', 'pour-autrui', { canRequestOnBehalf: true });
    const res = await onBehalf.get('/api/users');
    expect(res.statusCode).toBe(200);
    // Vue réduite : identité et droits de demande, ni rôle, ni droits propres, ni quotas.
    expect(res.json<MemberOption[]>()).toContainEqual(
      expect.objectContaining({ id: onBehalf.user.id, canRequestTv: true }),
    );
    expect(res.json<object[]>()[0]).not.toHaveProperty('permissions');
    expect((await (await as('member')).get('/api/users')).statusCode).toBe(403);
  });
});

describe('PUT /api/users/:id : droits et garde', () => {
  it(
    'le propriétaire enregistre l’écart au rôle ; changer de rôle sans droits remet le préréglage',
    SLOW_TEST,
    async () => {
      const { as } = await setup();
      const owner = await as('owner', 'proprietaire');
      const member = await as('member');
      const url = `/api/users/${member.user.id}`;
      const res = await owner.put(url, { role: 'member', permissions: { canViewStats: true, canRequestMovies: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json<Member>().permissions).toEqual({ canViewStats: true });
      // Quotas seuls : les droits restent.
      expect((await owner.put(url, { quotaOverride: null })).json<Member>().permissions).toEqual({
        canViewStats: true,
      });
      // Rôle changé sans `permissions` : préréglage du nouveau rôle.
      expect((await owner.put(url, { role: 'auto_approve' })).json<Member>()).toMatchObject({
        role: 'auto_approve',
        permissions: null,
      });
      // « Revenir au rôle ».
      await owner.put(url, { permissions: { canViewStats: true } });
      expect((await owner.put(url, { permissions: null })).json<Member>().permissions).toBeNull();
    },
  );

  it('un non-propriétaire qui gère les membres : garde serveur, quotas compris', SLOW_TEST, async () => {
    const { db, as } = await setup();
    const admin = await as('member', 'admin', { canManageUsers: true, canViewStats: true });
    const member = await as('member');
    const peer = await as('member', 'pair', { canManageUsers: true });
    const owner = await as('owner', 'proprietaire');

    const ok = await admin.put(`/api/users/${member.user.id}`, { permissions: { canViewStats: true } });
    expect(ok.statusCode).toBe(200);
    const quota = { movies: { limit: 1, days: 7 }, seasons: null };
    // Hors quota seulement : sinon un membre se libérerait des quotas par un autre (aucun changement de quota = permis).
    const refused = await admin.put(`/api/users/${member.user.id}`, { quotaOverride: quota });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/hors quota/);
    expect((await admin.put(`/api/users/${member.user.id}`, { quotaOverride: null })).statusCode).toBe(200);

    const grant = await admin.put(`/api/users/${member.user.id}`, { permissions: { canManageIssues: true } });
    expect(grant.statusCode).toBe(403);
    expect(grant.json().error).toMatch(/Gérer les signalements/);
    expect((await admin.put(`/api/users/${member.user.id}`, { role: 'manager' })).statusCode).toBe(403);
    expect(
      (await admin.put(`/api/users/${member.user.id}`, { permissions: { canManageUsers: true } })).statusCode,
    ).toBe(403);
    // Pair, lui-même, propriétaire : intouchables, même pour ses quotas.
    for (const id of [peer.user.id, admin.user.id, owner.user.id])
      expect((await admin.put(`/api/users/${id}`, { quotaOverride: quota })).statusCode, id).toBe(403);
    // Refus : rien n'a changé.
    expect(getUser(db, member.user.id)?.permissions).toEqual({ canViewStats: true });
  });
});

describe('garde contre l’escalade : quotas et rôle Gestionnaire réservés aux membres hors quota', () => {
  it('un gestionnaire des membres hors quota règle les quotas et attribue Gestionnaire', SLOW_TEST, async () => {
    const { as } = await setup();
    const exempt = await as('manager', 'hors-quota', { canManageUsers: true });
    const member = await as('member');
    const url = `/api/users/${member.user.id}`;
    expect(
      (await exempt.put(url, { quotaOverride: { movies: null, seasons: null, unlimited: true } })).statusCode,
    ).toBe(200);
    expect((await exempt.put(url, { role: 'manager' })).statusCode).toBe(200);
  });

  it(
    'refuse Gestionnaire, seul ou en masse, à qui a tous les droits mais est soumis aux quotas',
    SLOW_TEST,
    async () => {
      const { as } = await setup();
      const owner = await as('owner', 'proprietaire');
      // Tous les droits d'un gestionnaire par remplacements, mais rôle « membre » : soumis aux quotas.
      const quotaBound = await as('member', 'soumis', {
        ...rolePermissions('manager'),
        canManageUsers: true,
      });
      const member = await as('member');
      const single = await quotaBound.put(`/api/users/${member.user.id}`, { role: 'manager' });
      expect(single.statusCode).toBe(403);
      expect(single.json().error).toMatch(/hors quota/);
      const bulk = await quotaBound.post('/api/users/bulk', { ids: [member.user.id], role: 'manager' });
      expect(bulk.statusCode).toBe(403);
      expect(bulk.json().error).toMatch(/hors quota/);
      expect((await owner.put(`/api/users/${member.user.id}`, { role: 'manager' })).statusCode).toBe(200);
    },
  );
});

describe('POST /api/users/bulk', () => {
  it('rôle et droits pour plusieurs membres, en une transaction', SLOW_TEST, async () => {
    const { db, as } = await setup();
    const owner = await as('owner', 'proprietaire');
    const a = await as('member', 'a', { canViewStats: true });
    const b = await as('manager', 'b');
    const res = await owner.post('/api/users/bulk', {
      ids: [a.user.id, b.user.id],
      role: 'auto_approve',
      permissions: { canManageIssues: true, autoApprove4k: false },
    });
    expect(res.statusCode).toBe(200);
    for (const id of [a.user.id, b.user.id])
      expect(getUser(db, id)).toMatchObject({
        role: 'auto_approve',
        // Le préréglage remplace les droits propres, puis les changements s'appliquent.
        permissions: { autoApprove4k: false, canManageIssues: true },
      });
    // Sans rôle : seuls les droits changés, par-dessus les droits de chacun.
    await owner.post('/api/users/bulk', { ids: [a.user.id], permissions: { autoApprove4k: true } });
    expect(getUser(db, a.user.id)?.permissions).toEqual({ canManageIssues: true });
    // Même rôle que le sien : ses droits propres restent ; un autre rôle les remplace par son préréglage.
    await owner.post('/api/users/bulk', { ids: [a.user.id], role: 'auto_approve' });
    expect(getUser(db, a.user.id)?.permissions).toEqual({ canManageIssues: true });
    await owner.post('/api/users/bulk', { ids: [a.user.id], role: 'member' });
    expect(getUser(db, a.user.id)).toMatchObject({ role: 'member', permissions: null });
    expect((await owner.post('/api/users/bulk', { ids: [a.user.id] })).statusCode).toBe(400);
  });

  it('un membre refusé : rien n’est écrit, le refus le nomme', SLOW_TEST, async () => {
    const { db, as } = await setup();
    const admin = await as('member', 'admin', { canManageUsers: true, canViewStats: true });
    const a = await as('member', 'a');
    const peer = await as('member', 'pair', { canManageUsers: true });
    const res = await admin.post('/api/users/bulk', {
      ids: [a.user.id, peer.user.id],
      permissions: { canViewStats: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(`${peer.user.name} : Seul le propriétaire modifie un membre qui gère les membres`);
    expect(getUser(db, a.user.id)?.permissions).toBeNull();
    expect((await admin.post('/api/users/bulk', { ids: ['inconnu'], role: 'member' })).statusCode).toBe(404);
  });
});

describe('droits par défaut des nouveaux membres', () => {
  const defaultsUrl = '/api/users/defaults';

  it('propriétaire seulement ; enregistrés sous forme d’écart au rôle', SLOW_TEST, async () => {
    const { as } = await setup();
    const owner = await as('owner', 'proprietaire');
    const admin = await as('member', 'admin', { canManageUsers: true });
    expect((await admin.get(defaultsUrl)).statusCode).toBe(403);
    expect((await admin.put(defaultsUrl, { role: 'manager' })).statusCode).toBe(403);
    expect((await owner.get(defaultsUrl)).json()).toEqual({ role: 'member', permissions: null });
    const saved = await owner.put(defaultsUrl, {
      role: 'auto_approve',
      permissions: { autoApproveMovies: true, canRequestTv: false },
    });
    expect(saved.json()).toEqual({ role: 'auto_approve', permissions: { canRequestTv: false } });
  });

  it(
    'appliqués à la première connexion et à l’import, jamais à un membre existant ni au premier propriétaire',
    SLOW_TEST,
    async () => {
      const data = openDataDir(tempDir());
      const emby = await startServer({
        'POST /Users/AuthenticateByName': (req, res) => {
          const { Username } = req.body as { Username: string };
          if (Username === 'alice') return status(200, authenticateFixture)(req, res);
          return status(200, { User: { Id: 'u-new', Name: Username, Policy: { IsAdministrator: false } } })(req, res);
        },
        'GET /Users/Query': usersFixture,
      });
      setSetting(data.db, data.cryptoKey, 'emby', { url: emby.url, apiKey: 'CLE-EMBY' });
      const defaults = { role: 'auto_approve' as const, permissions: { canRequestTv: false } };
      setSetting(data.db, data.cryptoKey, 'memberDefaults', defaults);
      const app: FastifyInstance = await buildApp({ data });
      cleanups.push(() => app.close());
      const login = (username: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { username, password: 'bon' },
        });

      // Premier administrateur Emby : propriétaire, sans droits par défaut.
      expect((await login('alice')).statusCode).toBe(200);
      const alice = data.db.select().from(users).where(eq(users.role, 'owner')).get();
      expect(alice?.permissions).toBeNull();
      // Nouveau membre : droits par défaut.
      expect((await login('bob')).statusCode).toBe(200);
      expect(getUser(data.db, 'u-new')).toMatchObject(defaults);
      // Membre existant : ses droits restent à la reconnexion.
      setPermissions(data.db, 'u-new', null);
      await login('bob');
      expect(getUser(data.db, 'u-new')?.permissions).toBeNull();

      // Import : les comptes créés reçoivent les droits par défaut.
      const owner = await loginAsOwner(app);
      expect((await app.inject({ method: 'POST', url: '/api/users/import', headers: owner.headers })).statusCode).toBe(
        200,
      );
      expect(getUser(data.db, 'u-3')).toMatchObject(defaults);
    },
  );

  it('import direct : un membre déjà connu garde rôle et droits', SLOW_TEST, () => {
    const db = openDb(':memory:');
    const defaults = { role: 'manager' as const, permissions: null };
    const identity = { id: 'a', name: 'A', avatar: null };
    expect(importFromEmby(db, identity, new Date(), defaults).role).toBe('manager');
    setPermissions(db, 'a', { canViewStats: false });
    expect(importFromEmby(db, identity, new Date(), { role: 'member', permissions: null })).toMatchObject({
      role: 'manager',
      permissions: { canViewStats: false },
    });
  });
});

describe('migration 0013 sur une base existante', () => {
  it('ajoute `permissions` à null : rôles et quotas inchangés, droits du rôle', SLOW_TEST, () => {
    const sqlite = new Database(join(tempDir(), 'avant.db'));
    cleanups.push(() => sqlite.close(true));
    migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(tempDir(), 13) });
    sqlite.exec(`
      insert into users (id, name, role, quota_override) values ('m', 'M', 'manager', '{"movies":null,"seasons":null,"unlimited":true}');
      insert into sessions (id, user_id, expires_at) values ('s', 'm', 9999999999);
    `);

    migrate(drizzle({ client: sqlite }), { migrationsFolder });

    expect(sqlite.prepare('select role, quota_override, permissions from users').all()).toEqual([
      { role: 'manager', quota_override: '{"movies":null,"seasons":null,"unlimited":true}', permissions: null },
    ]);
    // Pas de recréation de table : les sessions restent.
    expect(sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
    expect(() => sqlite.prepare(`update users set permissions = '[]'`).run()).toThrow(/CHECK/);
    expect(() => sqlite.prepare(`update users set permissions = 'pas du json'`).run()).toThrow(/CHECK/);
  });
});
