import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { migrationsFolder } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import { LOGIN_LIMIT } from '../src/server/routes/auth.ts';
import { SESSION_TTL_MS } from '../src/server/services/sessions.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { getUser, upsertFromEmby } from '../src/server/services/users.ts';
import { CSRF_HEADERS, EMBY_TOKEN_PATH, embyTokenSessionSchema } from '../src/shared/auth.ts';
import { type MediaServerKind, mediaServerKindLabels } from '../src/shared/settings.ts';
import { closedPortUrl, type FakeHandler, type FakeRoutes, status } from './fake-server.ts';
import { trackApps, trackFakeServers, trackTempDirs, truncatedMigrations } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();
const tempDir = trackTempDirs();

const API_KEY = 'CLE-SERVEUR';
/** Jeton d'accès du membre : ne doit apparaître ni en base, ni dans les journaux, ni dans une réponse. */
const MEMBER_TOKEN = 'f00dfeedcafe4b1d9e0a1b2c3d4e5f60';
const ACCOUNT_ID = '4b1d9e0a-1b2c-3d4e-5f60-f00dfeedcafe';
const OTHER_ID = 'autre-compte';

type Dto = Record<string, unknown> & { Id: string };

const account = (overrides: Record<string, unknown> = {}): Dto => ({
  Id: ACCOUNT_ID,
  Name: 'alice',
  PrimaryImageTag: 'tag42',
  Policy: { IsAdministrator: true, IsDisabled: false },
  ...overrides,
});

type Headers = Record<string, string | string[] | undefined>;

/** Champ `nom="valeur"` d'un en-tête d'autorisation `MediaBrowser …`. */
const authField = (header: unknown, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(String(header ?? ''))?.[1];

/** Jeton présenté au faux serveur, selon son type (en-tête d'Emby ou de Jellyfin). */
const tokenSent = (kind: MediaServerKind, headers: Headers) =>
  authField(kind === 'emby' ? headers['x-emby-authorization'] : headers.authorization, 'Token');

/** Ne répond qu'au jeton du membre (401 sinon). */
const guarded =
  (kind: MediaServerKind, handler: FakeHandler): FakeHandler =>
  (req, res) =>
    tokenSent(kind, req.headers) === MEMBER_TOKEN ? handler(req, res) : status(401)(req, res);

/**
 * Faux Emby 4.10.2 : le jeton du membre appartient à `tokenUser`. `/Sessions` renvoie les sessions que voit ce jeton
 * (`otherSessions` : celles d'autres membres, vues par un administrateur ; plus une session de clé d'API sans `UserId`)
 * et, comme le vrai, celle qu'il crée pour l'appareil de l'en-tête, rattachée à `tokenUser` (`deviceSessions` fois :
 * 0 simule un serveur qui n'en crée pas). `/Users/{id}` pour chaque compte de `accounts`.
 */
function embyRoutes({
  tokenUser = ACCOUNT_ID,
  otherSessions = [],
  deviceSessions = 1,
  accounts = [account()],
}: {
  tokenUser?: string;
  /** Id du membre (appareil `tv-<id>`), ou session complète. */
  otherSessions?: Array<string | { UserId: string; DeviceId: string }>;
  deviceSessions?: number;
  accounts?: Dto[];
}): FakeRoutes {
  return {
    'GET /Sessions': guarded('emby', (req, res) => {
      const DeviceId = authField(req.headers['x-emby-authorization'], 'DeviceId');
      return status(200, [
        ...otherSessions.map((s) => (typeof s === 'string' ? { UserId: s, DeviceId: `tv-${s}` } : s)),
        { UserId: '', DeviceId: 'cle-api' },
        ...Array.from({ length: deviceSessions }, () => ({ UserId: tokenUser, DeviceId })),
      ])(req, res);
    }),
    ...Object.fromEntries(accounts.map((dto) => [`GET /Users/${dto.Id}`, guarded('emby', status(200, dto))])),
  };
}

/** Serveur où le jeton du membre désigne le compte `dto` (Jellyfin : `/Users/Me` ; Emby : session de vérification). */
const memberRoutes = (kind: MediaServerKind, dto: Dto = account()): FakeRoutes =>
  kind === 'emby'
    ? embyRoutes({ tokenUser: dto.Id, accounts: [dto] })
    : { 'GET /Users/Me': guarded(kind, status(200, dto)) };

/** App dont le serveur multimédia (de ce type) est un faux serveur. */
async function appWith(kind: MediaServerKind, routes: FakeRoutes) {
  const app = await newApp();
  const server = await serve(routes);
  setSetting(app.data.db, app.data.cryptoKey, 'mediaServer', {
    kind,
    url: server.url,
    apiKey: API_KEY,
    libraryIds: [],
    publicUrl: null,
  });
  return { app, server };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  userId: ACCOUNT_ID,
  accessToken: MEMBER_TOKEN,
  deviceName: 'Salon (Android TV)',
  ...overrides,
});

/** Appel d'un client natif : ni cookie, ni en-tête CSRF. */
const tokenLogin = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: EMBY_TOKEN_PATH, payload: payload as Record<string, unknown>, headers });

const passwordLogin = (app: FastifyInstance, headers: Record<string, string> = {}, password = 'bon') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...CSRF_HEADERS, ...headers },
    payload: { username: 'alice', password },
  });

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Lignes brutes écrites par pino (avant tout masquage du tampon des journaux). */
function captureLogs(app: FastifyInstance): string[] {
  const lines: string[] = [];
  const write = app.logs.write.bind(app.logs);
  vi.spyOn(app.logs, 'write').mockImplementation((line: string) => {
    lines.push(line);
    write(line);
  });
  return lines;
}

const paths = (server: { requests: Array<{ method: string; path: string }> }) =>
  server.requests.map((r) => `${r.method} ${r.path}`);

describe.each(['emby', 'jellyfin'] as const)('POST /api/auth/emby-token (%s)', (kind) => {
  const refused = { error: `Jeton ${mediaServerKindLabels[kind]} refusé` };

  it('ouvre une session nommée, renvoyée dans le corps, sans cookie', async () => {
    const { app, server } = await appWith(kind, memberRoutes(kind));
    const res = await tokenLogin(app, body(), { 'user-agent': 'Viewer/1.0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const session = embyTokenSessionSchema.parse(res.json());
    expect(session.viewer).toMatchObject({ id: ACCOUNT_ID, name: 'alice', role: 'owner' });
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);

    const row = app.data.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, hash(session.token)))
      .get();
    expect(row).toMatchObject({ userId: ACCOUNT_ID, deviceName: 'Salon (Android TV)', userAgent: 'Viewer/1.0' });

    // Appels faits avec le jeton du membre, jamais avec la clé d'API du serveur.
    expect(paths(server)).toEqual(kind === 'emby' ? ['GET /Sessions', `GET /Users/${ACCOUNT_ID}`] : ['GET /Users/Me']);
    for (const call of server.requests) {
      expect(tokenSent(kind, call.headers)).toBe(MEMBER_TOKEN);
      expect(JSON.stringify(call.headers)).not.toContain(API_KEY);
      // Jellyfin : le jeton seul, sans les champs d'appareil d'Request.
      if (kind === 'jellyfin') expect(call.headers.authorization).toBe(`MediaBrowser Token="${MEMBER_TOKEN}"`);
    }
  });

  it('id comparé sans casse ni tirets, membre existant rafraîchi', async () => {
    const { app } = await appWith(
      kind,
      memberRoutes(kind, account({ Name: 'alice B', Policy: { IsAdministrator: false } })),
    );
    upsertFromEmby(app.data.db, { id: ACCOUNT_ID, name: 'alice', avatar: null, isEmbyAdmin: false });
    const res = await tokenLogin(app, body({ userId: ACCOUNT_ID.replaceAll('-', '').toUpperCase() }));
    expect(res.statusCode).toBe(200);
    expect(res.json().viewer).toMatchObject({ id: ACCOUNT_ID, name: 'alice B', role: 'member' });
    expect(getUser(app.data.db, ACCOUNT_ID)?.name).toBe('alice B');
  });

  it('jeton refusé par le serveur : 401, ni membre ni session', async () => {
    const { app } = await appWith(kind, memberRoutes(kind));
    const res = await tokenLogin(app, body({ accessToken: 'jeton-inconnu' }));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(refused);
    expect(getUser(app.data.db, ACCOUNT_ID)).toBeNull();
    expect(app.data.db.select().from(sessions).all()).toHaveLength(0);
  });

  it('jeton d’un autre compte que celui annoncé : 401, le compte annoncé n’est jamais lu', async () => {
    const routes = memberRoutes(kind, account({ Id: OTHER_ID }));
    routes[`GET /Users/${ACCOUNT_ID}`] = guarded(kind, status(200, account()));
    const { app, server } = await appWith(kind, routes);
    const res = await tokenLogin(app, body());
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(refused);
    expect(getUser(app.data.db, ACCOUNT_ID)).toBeNull();
    expect(getUser(app.data.db, OTHER_ID)).toBeNull();
    expect(paths(server)).not.toContain(`GET /Users/${ACCOUNT_ID}`);
  });

  it('appel d’identité inconnu du serveur (404) : 401 générique, journalisé sans le jeton', async () => {
    const { app } = await appWith(kind, { [`GET /Users/${ACCOUNT_ID}`]: account() });
    const lines = captureLogs(app);
    const res = await tokenLogin(app, body());
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(refused);
    expect(lines.join('\n')).toContain('Connexion par jeton refusée');
    expect(lines.join('\n')).not.toContain(MEMBER_TOKEN);
  });
});

describe('POST /api/auth/emby-token (Emby : session de l’appareil de vérification)', () => {
  it('appareil de vérification neuf à chaque appel, dans X-Emby-Authorization', async () => {
    const { app, server } = await appWith('emby', memberRoutes('emby'));
    await tokenLogin(app, body());
    await tokenLogin(app, body());
    const sent = server.requests.filter((r) => r.path === '/Sessions').map((r) => r.headers['x-emby-authorization']);
    const deviceIds = sent.map((h) => authField(h, 'DeviceId'));
    expect(deviceIds).toHaveLength(2);
    for (const deviceId of deviceIds) expect(deviceId).toMatch(/^request-verify-[0-9a-f]{32}$/);
    expect(deviceIds[0]).not.toBe(deviceIds[1]);
    expect(authField(sent[0], 'Device')).toBe('Verification Viewer');
    expect(authField(sent[0], 'Client')).toBe('Request');
    expect(server.requests.every((r) => r.headers['x-emby-token'] === undefined)).toBe(true);
  });

  it('une session existante du membre annoncé, à un autre appareil, n’est jamais acceptée', async () => {
    // Jeton de A (administrateur : voit les sessions de B, dont une ancienne vérification) annonçant B.
    const b = account();
    const { app } = await appWith(
      'emby',
      embyRoutes({
        tokenUser: OTHER_ID,
        otherSessions: [ACCOUNT_ID, { UserId: ACCOUNT_ID, DeviceId: `request-verify-${'0'.repeat(32)}` }],
        accounts: [b],
      }),
    );
    const res = await tokenLogin(app, body());
    expect(res.statusCode).toBe(401);
    expect(getUser(app.data.db, ACCOUNT_ID)).toBeNull();
    // Même sans session créée pour l'appel, les sessions de B ne suffisent pas.
    const { app: again } = await appWith('emby', embyRoutes({ deviceSessions: 0, otherSessions: [ACCOUNT_ID] }));
    expect((await tokenLogin(again, body())).statusCode).toBe(401);
  });

  it('jeton d’administrateur (voit les sessions de tous) : accepté pour son propre compte', async () => {
    const { app } = await appWith('emby', embyRoutes({ otherSessions: [OTHER_ID, 'troisieme'] }));
    const res = await tokenLogin(app, body());
    expect(res.statusCode).toBe(200);
    expect(res.json().viewer).toMatchObject({ id: ACCOUNT_ID });
  });

  it('jeton d’administrateur : refusé pour un autre membre', async () => {
    const other = account({ Id: OTHER_ID, Name: 'bob' });
    const { app, server } = await appWith(
      'emby',
      embyRoutes({ otherSessions: [OTHER_ID], accounts: [account(), other] }),
    );
    const res = await tokenLogin(app, body({ userId: OTHER_ID }));
    expect(res.statusCode).toBe(401);
    expect(getUser(app.data.db, OTHER_ID)).toBeNull();
    expect(paths(server)).toEqual(['GET /Sessions']);
  });

  it('aucune ou plusieurs sessions à l’appareil de vérification : 401', async () => {
    for (const deviceSessions of [0, 2]) {
      const { app, server } = await appWith('emby', embyRoutes({ deviceSessions, otherSessions: [ACCOUNT_ID] }));
      const res = await tokenLogin(app, body());
      expect(res.statusCode, String(deviceSessions)).toBe(401);
      expect(res.json()).toEqual({ error: 'Jeton Emby refusé' });
      expect(getUser(app.data.db, ACCOUNT_ID)).toBeNull();
      expect(paths(server)).toEqual(['GET /Sessions']);
    }
  });
});

describe('POST /api/auth/emby-token', () => {
  it('le jeton n’est jamais conservé ni journalisé, en échec comme en succès', async () => {
    const { app } = await appWith('emby', memberRoutes('emby'));
    const lines = captureLogs(app);
    const failed = await tokenLogin(app, body({ userId: 'quelqu-un-d-autre' }));
    expect(failed.statusCode).toBe(401);
    const ok = await tokenLogin(app, body());
    expect(ok.statusCode).toBe(200);
    app.log.info('repère de fin');
    expect(lines.at(-1)).toContain('repère de fin');

    const dump = JSON.stringify([
      app.data.db.$client.prepare('SELECT * FROM sessions').all(),
      app.data.db.$client.prepare('SELECT * FROM users').all(),
      app.data.db.$client.prepare('SELECT * FROM settings').all(),
    ]);
    for (const text of [lines.join('\n'), failed.body, ok.body, dump]) expect(text).not.toContain(MEMBER_TOKEN);
  });

  it('compte désactivé : même refus que /login (401 et message)', async () => {
    const disabled = account({ Policy: { IsAdministrator: true, IsDisabled: true } });
    for (const routes of [{ 'GET /Sessions': status(403) }, memberRoutes('emby', disabled)]) {
      const { app } = await appWith('emby', { ...routes, 'POST /Users/AuthenticateByName': status(403) });
      const res = await tokenLogin(app, body());
      const login = await passwordLogin(app);
      expect(res.statusCode).toBe(login.statusCode);
      expect(res.json()).toEqual(login.json());
      expect(res.json()).toEqual({ error: 'Compte Emby désactivé ou non autorisé' });
      expect(getUser(app.data.db, ACCOUNT_ID)).toBeNull();
    }
  });

  it('serveur injoignable : même erreur que /login', async () => {
    const app = await newApp();
    setSetting(app.data.db, app.data.cryptoKey, 'mediaServer', {
      kind: 'emby',
      url: await closedPortUrl(),
      apiKey: API_KEY,
      libraryIds: [],
      publicUrl: null,
    });
    const res = await tokenLogin(app, body());
    const login = await passwordLogin(app);
    expect(res.statusCode).toBe(502);
    expect(res.statusCode).toBe(login.statusCode);
    expect(res.json()).toEqual(login.json());
  });

  it('400 sans serveur Emby ou Jellyfin (Plex ou aucun)', async () => {
    const bare = await newApp();
    expect((await tokenLogin(bare, body())).statusCode).toBe(400);
    const { app, server } = await appWith('plex', {});
    const res = await tokenLogin(app, body());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Emby ou Jellyfin/);
    expect(server.requests).toHaveLength(0);
  });

  it('400 sur un corps invalide, sans appeler le serveur', async () => {
    const { app, server } = await appWith('jellyfin', memberRoutes('jellyfin'));
    for (const payload of [
      {},
      body({ deviceName: undefined }),
      body({ deviceName: '   ' }),
      body({ deviceName: 'x'.repeat(65) }),
      body({ deviceName: 'Salon\nfaux' }),
      body({ accessToken: '' }),
      body({ accessToken: 'abc", Token="autre' }),
      body({ accessToken: 'é'.repeat(10) }),
      body({ accessToken: 'a'.repeat(513) }),
      body({ userId: '' }),
      body({ userId: 'a/b' }),
      body({ userId: 'a'.repeat(65) }),
    ])
      expect((await tokenLogin(app, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect(server.requests).toHaveLength(0);
    // Nom d'appareil rogné.
    const res = await tokenLogin(app, body({ deviceName: '  Bureau  ' }));
    const row = app.data.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, hash(res.json().token)))
      .get();
    expect(row?.deviceName).toBe('Bureau');
  });

  it('pas d’en-tête CSRF exigé, même avec une origine étrangère', async () => {
    const { app } = await appWith('emby', memberRoutes('emby'));
    const res = await tokenLogin(app, body(), { origin: 'https://ailleurs.example' });
    expect(res.statusCode).toBe(200);
  });

  it('même limite que /login, par adresse, avant tout appel au serveur', async () => {
    const { app, server } = await appWith('emby', {
      ...memberRoutes('emby'),
      'POST /Users/AuthenticateByName': status(401),
    });
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const half = Math.floor(LOGIN_LIMIT.limit / 2);
    for (let i = 0; i < half; i++) expect((await passwordLogin(app, from('10.0.0.1'), 'faux')).statusCode).toBe(401);
    for (let i = half; i < LOGIN_LIMIT.limit; i++)
      expect((await tokenLogin(app, body({ accessToken: 'faux' }), from('10.0.0.1'))).statusCode).toBe(401);
    const calls = server.requests.length;
    const blocked = await tokenLogin(app, body(), from('10.0.0.1'));
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(server.requests).toHaveLength(calls);
    expect((await tokenLogin(app, body(), from('10.0.0.2'))).statusCode).toBe(200);
  });
});

describe('migration 0016_sessions_appareil', () => {
  it('ajoute device_name sans toucher aux sessions existantes', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: truncatedMigrations(tempDir(), 16) });
    sqlite.prepare("INSERT INTO users (id, name, role) VALUES ('u', 'u', 'member')").run();
    sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s', 'u', 9999999999)").run();
    migrate(db, { migrationsFolder });
    expect(sqlite.prepare('SELECT id, device_name FROM sessions').all()).toEqual([{ id: 's', device_name: null }]);
    sqlite.close();
  });
});
