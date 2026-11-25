import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/server/crypto.ts';
import { migrationsFolder } from '../src/server/db/index.ts';
import { apiKeys } from '../src/server/db/schema.ts';
import {
  API_KEY_LIMIT,
  API_KEY_SCOPE_ROUTES,
  OUT_OF_SCOPE_ERROR,
  PUBLIC_ROUTES,
  WEBHOOK_ROUTES,
} from '../src/server/plugins/auth.ts';
import { LAST_USED_REFRESH_MS } from '../src/server/services/api-keys.ts';
import {
  API_KEYS_PATH,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyScope,
  apiKeyPath,
  apiKeyScopes,
} from '../src/shared/api-keys.ts';
import { GENERAL_SETTINGS_PATH } from '../src/shared/app-info.ts';
import { VIEWER_PATH } from '../src/shared/auth.ts';
import { REQUESTS_PATH, requestPath } from '../src/shared/requests.ts';
import {
  appWithApiRoutes,
  loginAs,
  loginAsOwner,
  setRole,
  trackApps,
  trackTempDirs,
  truncatedMigrations,
} from './helpers.ts';

const newApp = trackApps();
const tempDir = trackTempDirs();
const UNTRUSTED = '203.0.113.7';

/** Crée une clé par la route (session propriétaire) et renvoie sa réponse ; `scope` absent : le corps n'en porte pas. */
async function createKey(app: FastifyInstance, name = 'Script', scope?: ApiKeyScope) {
  const owner = await loginAsOwner(app);
  const res = await app.inject({
    method: 'POST',
    url: API_KEYS_PATH,
    headers: owner.headers,
    payload: { name, ...(scope && { scope }) },
  });
  expect(res.statusCode).toBe(201);
  return { owner, created: res.json<ApiKeyCreated>() };
}

const withKey = (app: FastifyInstance, secret: string, url = '/api/auth/me', remoteAddress?: string) =>
  app.inject({ method: 'GET', url, headers: { 'x-api-key': secret }, ...(remoteAddress && { remoteAddress }) });

describe('création et liste des clés', () => {
  it('renvoie le secret une seule fois et ne garde que son hash SHA-256', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app, '  Home Assistant  ');
    expect(created.secret).toMatch(/^ur_[\w-]{43}$/);
    expect(created.apiKey).toMatchObject({
      name: 'Home Assistant',
      createdByName: owner.user.name,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.secret.startsWith(created.apiKey.prefix)).toBe(true);
    expect(created.apiKey.prefix).toHaveLength(8);

    const [row] = app.data.db.select().from(apiKeys).all();
    expect(row?.keyHash).toBe(sha256Hex(created.secret));
    expect(JSON.stringify(row)).not.toContain(created.secret);

    const list = await app.inject({ method: 'GET', url: API_KEYS_PATH, headers: owner.headers });
    expect(list.json<ApiKey[]>()).toEqual([created.apiKey]);
    expect(list.body).not.toContain(created.secret);
    expect(list.body).not.toContain(sha256Hex(created.secret));
  });

  it('deux clés ont deux secrets différents ; nom vide refusé', async () => {
    const app = await newApp();
    const a = await createKey(app, 'A');
    const b = await createKey(app, 'B');
    expect(a.created.secret).not.toBe(b.created.secret);
    const bad = await app.inject({
      method: 'POST',
      url: API_KEYS_PATH,
      headers: a.owner.headers,
      payload: { name: ' ' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('est réservé au propriétaire (session)', async () => {
    const app = await newApp();
    const { created } = await createKey(app);
    const manager = await loginAs(app, 'manager');
    expect((await app.inject({ method: 'GET', url: API_KEYS_PATH })).statusCode).toBe(401);
    for (const [method, url] of [
      ['GET', API_KEYS_PATH],
      ['POST', API_KEYS_PATH],
      ['DELETE', apiKeyPath(created.apiKey.id)],
    ] as const) {
      const res = await app.inject({ method, url, headers: manager.headers, payload: { name: 'x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('révocation', () => {
  it('révoque (204), garde la clé listée et la refuse ensuite ; idempotente, 404 si inconnue', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app);
    expect((await withKey(app, created.secret)).statusCode).toBe(200);

    const url = apiKeyPath(created.apiKey.id);
    expect((await app.inject({ method: 'DELETE', url, headers: owner.headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url, headers: owner.headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: apiKeyPath(999), headers: owner.headers })).statusCode).toBe(404);

    const res = await withKey(app, created.secret);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Clé d’API invalide' });
    const list = await app.inject({ method: 'GET', url: API_KEYS_PATH, headers: owner.headers });
    expect(list.json<ApiKey[]>()[0]?.revokedAt).not.toBeNull();
  });
});

describe('authentification par X-Api-Key', () => {
  it('agit comme son créateur, sans cookie ni en-tête CSRF, y compris en écriture', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app);
    const me = await withKey(app, created.secret);
    expect(me.statusCode).toBe(200);
    expect(me.json().viewer).toMatchObject({ id: owner.user.id, role: 'owner' });
    // POST sans en-tête CSRF ni origine : pas de cookie à protéger.
    const write = await app.inject({
      method: 'POST',
      url: '/api/requests/batch',
      headers: { 'x-api-key': created.secret, origin: 'https://autre-site.example' },
      payload: { action: 'decline', ids: [] },
    });
    expect(write.statusCode).not.toBe(403);
    expect(write.statusCode).not.toBe(401);
  });

  it('refuse une clé inconnue, vide ou en double (401) sur toute route, publiques comprises', async () => {
    const app = await newApp();
    for (const value of ['ur_inconnue', '']) {
      for (const url of ['/api/auth/me', '/api/health']) {
        const res = await app.inject({ method: 'GET', url, headers: { 'x-api-key': value } });
        expect(res.statusCode, `${url} « ${value} »`).toBe(401);
      }
    }
    const twice = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-api-key': ['a', 'b'] } });
    expect(twice.statusCode).toBe(401);
  });

  it('refuse l’appelant combinant cookie de session et clé (400), même valides', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { ...owner.headers, 'x-api-key': created.secret },
    });
    expect(res.statusCode).toBe(400);
    // Une clé fausse avec un cookie valide ne se replie pas sur la session.
    const bad = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { ...owner.headers, 'x-api-key': 'ur_x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuse une clé dont le créateur n’est plus propriétaire, et la reprend s’il le redevient', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app);
    await loginAs(app, 'owner', 'autre-proprietaire');
    setRole(app.data.db, owner.user.id, 'manager');
    expect((await withKey(app, created.secret)).statusCode).toBe(401);
    setRole(app.data.db, owner.user.id, 'owner');
    expect((await withKey(app, created.secret)).statusCode).toBe(200);
  });

  it('une clé ne gère pas les clés (403) : ni liste, ni création, ni révocation', async () => {
    const app = await newApp();
    const { created } = await createKey(app);
    for (const [method, url] of [
      ['GET', API_KEYS_PATH],
      ['POST', API_KEYS_PATH],
      ['DELETE', apiKeyPath(created.apiKey.id)],
    ] as const) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': created.secret }, payload: { name: 'x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(app.data.db.select().from(apiKeys).all()).toHaveLength(1);
    expect(app.data.db.select().from(apiKeys).all()[0]?.revokedAt).toBeNull();
  });

  it('met à jour last_used_at au plus une fois par minute', async () => {
    const app = await newApp();
    const { created } = await createKey(app);
    const lastUsed = () => app.data.db.select().from(apiKeys).get()?.lastUsedAt?.getTime() ?? null;
    expect(lastUsed()).toBeNull();

    await withKey(app, created.secret);
    const first = lastUsed();
    expect(first).not.toBeNull();

    // Une seconde plus tard : pas de nouvelle écriture.
    const recent = new Date((first ?? 0) - 1000);
    app.data.db.update(apiKeys).set({ lastUsedAt: recent }).run();
    await withKey(app, created.secret);
    expect(lastUsed()).toBe(recent.getTime());

    // Plus d'une minute : réécrit.
    const old = new Date((first ?? 0) - LAST_USED_REFRESH_MS - 5000);
    app.data.db.update(apiKeys).set({ lastUsedAt: old }).where(eq(apiKeys.id, created.apiKey.id)).run();
    await withKey(app, created.secret);
    expect(lastUsed()).toBeGreaterThan(old.getTime());
  });

  it('limite les clés invalides par IP : 429 ensuite, une clé valide passe toujours', async () => {
    const app = await newApp();
    const { created } = await createKey(app);
    for (let i = 0; i < API_KEY_LIMIT.limit; i++)
      expect((await withKey(app, `ur_faux${i}`, '/api/auth/me', UNTRUSTED)).statusCode).toBe(401);

    const blocked = await withKey(app, 'ur_faux', '/api/auth/me', UNTRUSTED);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await withKey(app, 'ur_faux_encore', '/api/auth/me', UNTRUSTED)).statusCode).toBe(429);
    expect((await withKey(app, created.secret, '/api/auth/me', UNTRUSTED)).statusCode).toBe(200);
  });

  it('les requêtes réussies ne comptent pas dans la limite', async () => {
    const app = await newApp();
    const { created } = await createKey(app);
    for (let i = 0; i < API_KEY_LIMIT.limit * 2; i++)
      expect((await withKey(app, created.secret, '/api/auth/me', UNTRUSTED)).statusCode).toBe(200);
  });
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const call = (app: FastifyInstance, secret: string, method: Method, url: string) =>
  app.inject({
    method,
    url,
    headers: { 'x-api-key': secret },
    ...(method !== 'GET' && method !== 'DELETE' && { payload: {} }),
  });

describe('portée des clés', () => {
  it('crée une clé complète par défaut, et refuse une portée inconnue', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app);
    expect(created.apiKey.scope).toBe('full');
    const bad = await app.inject({
      method: 'POST',
      url: API_KEYS_PATH,
      headers: owner.headers,
      payload: { name: 'x', scope: 'admin' },
    });
    expect(bad.statusCode).toBe(400);
    const list = await app.inject({ method: 'GET', url: API_KEYS_PATH, headers: owner.headers });
    expect(list.json<ApiKey[]>().map((key) => key.scope)).toEqual(['full']);
  });

  it('une clé « lecture » lit les demandes mais ne peut pas en créer (403)', async () => {
    const app = await newApp();
    const { created } = await createKey(app, 'Hub', 'read');
    expect(created.apiKey.scope).toBe('read');
    expect((await call(app, created.secret, 'GET', REQUESTS_PATH)).statusCode).toBe(200);
    const write = await call(app, created.secret, 'POST', REQUESTS_PATH);
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: OUT_OF_SCOPE_ERROR });
    // Une route publique reste ouverte.
    expect((await call(app, created.secret, 'GET', '/api/health')).statusCode).toBe(200);
  });

  it('une clé « demandes » approuve et refuse, mais n’ouvre pas les réglages (403)', async () => {
    const app = await newApp();
    const { created } = await createKey(app, 'Hub', 'requests');
    expect((await call(app, created.secret, 'GET', GENERAL_SETTINGS_PATH)).statusCode).toBe(403);
    expect((await call(app, created.secret, 'PUT', GENERAL_SETTINGS_PATH)).statusCode).toBe(403);
    // Routes ouvertes : le garde de portée laisse passer (la suite, 404 ou 400, vient de la route).
    for (const action of ['approve', 'decline'] as const)
      expect((await call(app, created.secret, 'POST', requestPath(999, action))).statusCode).not.toBe(403);
    expect((await call(app, created.secret, 'POST', requestPath(999, 'cancel'))).statusCode).toBe(403);
    expect((await call(app, created.secret, 'POST', '/api/requests/batch')).statusCode).toBe(403);
    expect((await call(app, created.secret, 'POST', REQUESTS_PATH)).statusCode).toBe(400);
  });

  it('une clé « complète » garde l’accès d’avant les portées', async () => {
    const app = await newApp();
    const { created } = await createKey(app, 'Script', 'full');
    expect((await call(app, created.secret, 'GET', GENERAL_SETTINGS_PATH)).statusCode).toBe(200);
  });

  it('une clé inconnue est refusée avant la portée (401)', async () => {
    const app = await newApp();
    expect((await call(app, 'ur_inconnue', 'POST', REQUESTS_PATH)).statusCode).toBe(401);
  });

  it('GET /api/auth/me renvoie la portée de la clé, null avec un cookie', async () => {
    const app = await newApp();
    const { owner, created } = await createKey(app, 'Hub', 'requests');
    const viaKey = await call(app, created.secret, 'GET', VIEWER_PATH);
    expect(viaKey.json()).toMatchObject({ viewer: { id: owner.user.id }, apiKeyScope: 'requests' });
    const viaCookie = await app.inject({ method: 'GET', url: VIEWER_PATH, headers: owner.headers });
    expect(viaCookie.json().apiKeyScope).toBeNull();
  });

  it('la migration 0017 laisse les clés existantes « complètes »', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: truncatedMigrations(tempDir(), 17) });
    sqlite.prepare("INSERT INTO users (id, name, role) VALUES ('u', 'u', 'owner')").run();
    sqlite
      .prepare("INSERT INTO api_keys (name, key_hash, prefix, created_by) VALUES ('Ancienne', 'h', 'ur_anci', 'u')")
      .run();
    migrate(db, { migrationsFolder });
    expect(sqlite.prepare('SELECT name, scope FROM api_keys').all()).toEqual([{ name: 'Ancienne', scope: 'full' }]);
    // La contrainte est en place : une portée inconnue est refusée.
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO api_keys (name, key_hash, prefix, scope, created_by) VALUES ('x', 'h2', 'ur_x', 'admin', 'u')",
        )
        .run(),
    ).toThrow(/CHECK/);
    sqlite.close(true);
  });

  it('une clé d’avant les portées reste « complète » à l’authentification', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const secret = 'ur_ancienne-cle';
    app.data.db.$client
      .prepare('INSERT INTO api_keys (name, key_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Ancienne', sha256Hex(secret), 'ur_anci', owner.user.id, 1);
    expect((await call(app, secret, 'GET', GENERAL_SETTINGS_PATH)).statusCode).toBe(200);
    expect((await call(app, secret, 'GET', VIEWER_PATH)).json().apiKeyScope).toBe('full');
  });

  it('liste blanche : chaque entrée est une route enregistrée, tout le reste est refusé (403)', async () => {
    const { app, routes } = await appWithApiRoutes(newApp);
    const owner = await loginAsOwner(app);
    const scopes = apiKeyScopes.filter((scope) => scope !== 'full');
    const secrets = new Map<ApiKeyScope, string>();
    for (const scope of scopes) {
      const res = await app.inject({
        method: 'POST',
        url: API_KEYS_PATH,
        headers: owner.headers,
        payload: { name: scope, scope },
      });
      secrets.set(scope, res.json<ApiKeyCreated>().secret);
    }

    for (const scope of scopes)
      for (const entry of API_KEY_SCOPE_ROUTES[scope]) expect(routes, `${scope} : ${entry}`).toContain(entry);
    // « demandes » ouvre au moins tout ce qu'ouvre « lecture ».
    for (const entry of API_KEY_SCOPE_ROUTES.read) expect(API_KEY_SCOPE_ROUTES.requests.has(entry)).toBe(true);

    for (const route of routes) {
      if (PUBLIC_ROUTES.has(route) || WEBHOOK_ROUTES.has(route)) continue;
      const [method, pattern] = route.split(' ') as [Method, string];
      for (const scope of scopes) {
        const res = await call(app, secrets.get(scope) ?? '', method, pattern.replace(/:\w+/g, '1'));
        const refused = res.statusCode === 403 && res.json<{ error?: string }>().error === OUT_OF_SCOPE_ERROR;
        expect(refused, `${scope} sur ${route}`).toBe(!API_KEY_SCOPE_ROUTES[scope].has(route));
        if (scope === 'read' && method !== 'GET') expect(res.statusCode, `lecture sur ${route}`).toBe(403);
      }
    }
  });
});
