import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { jobRuns, sessions } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { createSync, SCAN_JOBS } from '../src/server/services/sync.ts';
import type { MediaServerKind } from '../src/shared/settings.ts';
import { type FakeHandler, type FakeRoutes, status } from './fake-server.ts';
import { loginAs, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

const PLEX_OWNER_TOKEN = 'JETON-PROPRIETAIRE';
const MACHINE = 'machine-1';

/** Compte du serveur multimédia ; `disabled` n'existe pas chez Plex (un membre sans accès n'est plus listé). */
interface Account {
  id: string;
  name: string;
  disabled?: boolean;
}

/** Faux serveur multimédia à l'état modifiable : `accounts` est relu à chaque appel, `down` le fait répondre 500. */
interface FakeMediaServer {
  accounts: Account[];
  down: boolean;
}

const guarded =
  (state: FakeMediaServer, body: () => unknown): FakeHandler =>
  (req, res) =>
    state.down ? status(500)(req, res) : status(200, body())(req, res);

const embyUsers = (accounts: Account[]) => ({
  Items: accounts.map((a) => ({
    Id: a.id,
    Name: a.name,
    Policy: { IsAdministrator: a.id === '1', IsDisabled: a.disabled ?? false },
  })),
  TotalRecordCount: accounts.length,
});

/** Amis de Plex : tous les comptes sauf le propriétaire (id 1), qui vient de `/users/account.json`. */
const plexFriends =
  (state: FakeMediaServer): FakeHandler =>
  (req, res) => {
    if (state.down) return status(500)(req, res);
    const friends = state.accounts
      .filter((a) => a.id !== '1')
      .map((a) => `<User id="${a.id}" title="${a.name}"><Server machineIdentifier="${MACHINE}" name="Salon"/></User>`);
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><MediaContainer>${friends.join('')}</MediaContainer>`);
  };

/** Application dont le serveur multimédia de ce type est un faux serveur piloté par `state`. */
async function appWith(kind: MediaServerKind, state: FakeMediaServer) {
  const base = { libraryIds: [], publicUrl: null };
  if (kind === 'plex') {
    const plexTv = await serve({
      'GET /users/account.json': { user: { id: 1, username: 'proprio', title: 'Alice', thumb: '' } },
      'GET /api/users': plexFriends(state),
    });
    const pms = await serve({ 'GET /': { MediaContainer: { version: '1', machineIdentifier: MACHINE } } });
    const app = await newApp({ upstreams: { plexTvUrl: plexTv.url } });
    setSetting(app.data.db, app.data.cryptoKey, 'mediaServer', {
      kind,
      url: pms.url,
      apiKey: PLEX_OWNER_TOKEN,
      ...base,
    });
    return app;
  }
  const routes: FakeRoutes =
    kind === 'emby'
      ? { 'GET /Users/Query': guarded(state, () => embyUsers(state.accounts)) }
      : { 'GET /Users': guarded(state, () => embyUsers(state.accounts).Items) };
  const server = await serve(routes);
  const app = await newApp();
  setSetting(app.data.db, app.data.cryptoKey, 'mediaServer', { kind, url: server.url, apiKey: 'CLE', ...base });
  return app;
}

const sessionsOf = (app: FastifyInstance, userId: string) =>
  app.data.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)).get()?.n ?? 0;

const fullScanDetail = (app: FastifyInstance) =>
  app.data.db.select().from(jobRuns).where(eq(jobRuns.job, SCAN_JOBS.full)).get()?.detail;

describe.each(['emby', 'jellyfin', 'plex'] as const)('balayage complet : membres de %s', (kind) => {
  /** `owners` : propriétaires de l'appli (le propriétaire Plex a l'id 1) ; Bob et Carol sont de simples membres. */
  async function setup({ owners = ['1'] }: { owners?: string[] } = {}) {
    const state: FakeMediaServer = {
      accounts: [
        { id: '1', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      down: false,
    };
    const app = await appWith(kind, state);
    for (const id of owners) await loginAs(app, 'owner', id);
    for (const id of ['bob', 'carol']) await loginAs(app, 'member', id);
    const sync = createSync(app.data, { availability: app.availability, mediaServers: app.mediaServers });
    return { app, state, sync };
  }

  it('membre retiré du serveur : ses sessions sont révoquées, celles des autres restent', async () => {
    const { app, state, sync } = await setup();
    state.accounts = state.accounts.filter((a) => a.id !== 'bob');
    expect(await sync.fullScan()).toBe(true);
    expect(sessionsOf(app, 'bob')).toBe(0);
    expect(sessionsOf(app, 'carol')).toBe(1);
    expect(sessionsOf(app, '1')).toBe(1);
    expect(fullScanDetail(app)).toContain('1 membre déconnecté');
  });

  it.skipIf(kind === 'plex')('membre désactivé sur le serveur : ses sessions sont révoquées', async () => {
    const { app, state, sync } = await setup();
    state.accounts = state.accounts.map((a) => (a.id === 'carol' ? { ...a, disabled: true } : a));
    await sync.fullScan();
    expect(sessionsOf(app, 'carol')).toBe(0);
    expect(sessionsOf(app, 'bob')).toBe(1);
  });

  it('serveur injoignable ou en erreur : aucune session révoquée', async () => {
    const { app, state, sync } = await setup();
    state.accounts = [];
    state.down = true;
    expect(await sync.fullScan()).toBe(true);
    for (const id of ['1', 'bob', 'carol']) expect(sessionsOf(app, id), id).toBe(1);
    expect(fullScanDetail(app)).toContain('non vérifiés');
  });

  it('réglage du serveur illisible (current lève) : balayage en succès, titres recalculés, aucune session révoquée', async () => {
    const { app } = await setup();
    const mediaServers = {
      ...app.mediaServers,
      current: () => {
        throw new Error('réglage illisible');
      },
    };
    const sync = createSync(app.data, { availability: app.availability, mediaServers });
    expect(await sync.fullScan()).toBe(true);
    for (const id of ['1', 'bob', 'carol']) expect(sessionsOf(app, id), id).toBe(1);
    expect(fullScanDetail(app)).toContain('titres recalculés');
    expect(fullScanDetail(app)).toContain('non vérifiés');
    expect(app.data.db.select().from(jobRuns).get()?.status).toBe('success');
  });

  it('liste réduite au propriétaire : le dernier membre retiré est déconnecté, le propriétaire reste', async () => {
    const { app, state, sync } = await setup();
    state.accounts = state.accounts.filter((a) => a.id === '1');
    await sync.fullScan();
    expect(sessionsOf(app, '1')).toBe(1);
    for (const id of ['bob', 'carol']) expect(sessionsOf(app, id), id).toBe(0);
  });

  it.skipIf(kind === 'plex')(
    'liste réduite au propriétaire et aux membres désactivés : ils sont déconnectés',
    async () => {
      const { app, state, sync } = await setup();
      state.accounts = state.accounts.map((a) => (a.id === '1' ? a : { ...a, disabled: true }));
      await sync.fullScan();
      expect(sessionsOf(app, '1')).toBe(1);
      for (const id of ['bob', 'carol']) expect(sessionsOf(app, id), id).toBe(0);
    },
  );

  // Plex y met toujours son propriétaire (compte connu) : une liste vide ou sans compte connu n'existe pas de son côté.
  it.skipIf(kind === 'plex')('liste vide : aucune session révoquée', async () => {
    const { app, state, sync } = await setup();
    state.accounts = [];
    await sync.fullScan();
    for (const id of ['1', 'bob', 'carol']) expect(sessionsOf(app, id), id).toBe(1);
  });

  it.skipIf(kind === 'plex')('liste ne nommant aucun compte connu de l’appli : aucune session révoquée', async () => {
    const { app, state, sync } = await setup();
    state.accounts = [{ id: 'inconnu', name: 'Zoé' }];
    await sync.fullScan();
    for (const id of ['1', 'bob', 'carol']) expect(sessionsOf(app, id), id).toBe(1);
  });

  it('le dernier propriétaire n’est jamais déconnecté, même absent de la liste', async () => {
    const { app, sync } = await setup({ owners: ['gerant'] });
    await sync.fullScan();
    expect(sessionsOf(app, 'gerant')).toBe(1);
    expect(fullScanDetail(app)).toContain('propriétaire conservé');
  });

  it('un propriétaire absent est déconnecté tant qu’un autre propriétaire reste sur le serveur', async () => {
    const { app, sync } = await setup({ owners: ['1', 'gerant'] });
    await sync.fullScan();
    expect(sessionsOf(app, 'gerant')).toBe(0);
    expect(sessionsOf(app, '1')).toBe(1);
  });
});
