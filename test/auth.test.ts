import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { LOGIN_LIMIT } from '../src/server/routes/auth.ts';
import { SESSION_TTL_MS } from '../src/server/services/sessions.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { getUser } from '../src/server/services/users.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { type FakeHandler, status } from './fake-server.ts';
import authenticateFixture from './fixtures/emby/authenticate.json';
import { loginAs, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

/** Emby factice : alice (admin, mot de passe « bon »), carol (membre, sans mot de passe). */
const authenticate: FakeHandler = (req, res) => {
  const { Username, Pw } = req.body as { Username: string; Pw: string };
  if (Username === 'alice' && Pw === 'bon') return status(200, authenticateFixture)(req, res);
  if (Username === 'carol' && Pw === '') return status(200, { User: { Id: 'u-3', Name: 'carol' } })(req, res);
  return status(401)(req, res);
};

/** App avec Emby configuré sur un faux serveur. */
async function appWithEmby() {
  const app = await newApp();
  const emby = await serve({ 'POST /Users/AuthenticateByName': authenticate });
  setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: emby.url, apiKey: 'CLE-EMBY' });
  return app;
}

const csrf = CSRF_HEADERS;
/** Par défaut l'appel vient de la boucle locale (proxy de confiance) ; `remoteAddress` simule un autre appelant. */
const login = (
  app: FastifyInstance,
  username: string,
  password: string,
  headers: Record<string, string> = {},
  remoteAddress?: string,
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...csrf, ...headers },
    payload: { username, password },
    ...(remoteAddress && { remoteAddress }),
  });
const UNTRUSTED = '203.0.113.7';

const sessionCookie = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const cookie = res.cookies.find((c) => c.name === 'request_session');
  if (!cookie) throw new Error('cookie de session absent');
  return cookie;
};

describe('garde de /api', () => {
  it('renvoie 401 sur une route protégée sans session', async () => {
    const app = await newApp();
    for (const url of ['/api/auth/me', '/api/users', '/api/settings/emby']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: 'Connexion requise' });
    }
  });

  it('laisse passer la liste publique', async () => {
    const app = await newApp();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).statusCode).toBe(200);
    // Atteint la route : 409 (Emby absent) et non 401.
    expect((await login(app, 'alice', 'bon')).statusCode).toBe(409);
  });

  it('refuse un cookie falsifié', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'member');
    const forged = headers.cookie?.replace(/\.[^.]+$/, '.signature-fausse');
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: forged ?? '' } });
    expect(res.statusCode).toBe(401);
  });

  it('403 sur un droit manquant', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'member');
    const res = await app.inject({ method: 'GET', url: '/api/users', headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Accès refusé' });
  });
});

describe('CSRF', () => {
  it("refuse une écriture sans l'en-tête maison", async () => {
    const app = await appWithEmby();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'bon' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.cookies).toHaveLength(0);
  });

  it('refuse une origine étrangère, accepte la même origine', async () => {
    const app = await appWithEmby();
    expect((await login(app, 'alice', 'bon', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await login(app, 'alice', 'bon', { origin: 'null' })).statusCode).toBe(403);
    expect((await login(app, 'alice', 'bon', { origin: 'http://localhost:80', host: 'localhost:80' })).statusCode).toBe(
      200,
    );
  });

  it('suit l’hôte annoncé par le proxy de confiance', async () => {
    const app = await appWithEmby();
    const headers = { origin: 'https://demandes.example', 'x-forwarded-host': 'demandes.example' };
    expect((await login(app, 'alice', 'bon', headers)).statusCode).toBe(200);
  });

  it('ignore X-Forwarded-Host venant d’une adresse non fiable', async () => {
    const app = await appWithEmby();
    const headers = { origin: 'https://demandes.example', 'x-forwarded-host': 'demandes.example' };
    const res = await login(app, 'alice', 'bon', headers, UNTRUSTED);
    expect(res.statusCode).toBe(403);
    expect(res.cookies).toHaveLength(0);
  });
});

describe('POST /api/auth/login', () => {
  it('ouvre une session httpOnly ; le premier admin Emby devient propriétaire', async () => {
    const app = await appWithEmby();
    const res = await login(app, 'alice', 'bon');
    expect(res.statusCode).toBe(200);
    const { viewer } = res.json();
    expect(viewer).toEqual({
      id: 'u-1',
      name: 'alice',
      role: 'owner',
      capabilities: expect.objectContaining({ isOwner: true, canManageUsers: true }),
      avatarUrl: '/api/users/u-1/avatar',
    });
    const cookie = sessionCookie(res) as Record<string, unknown>;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie.secure).toBeUndefined();
    expect(res.body).not.toContain('TOKEN-TO-NEVER-LEAK');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `request_session=${cookie.value}` },
    });
    expect(me.json()).toEqual({ viewer });
  });

  it('pose un cookie secure derrière un proxy HTTPS', async () => {
    const app = await appWithEmby();
    const res = await login(app, 'alice', 'bon', { 'x-forwarded-proto': 'https' });
    expect(sessionCookie(res)).toMatchObject({ secure: true });
  });

  it('un membre ordinaire arrive « Membre »', async () => {
    const app = await appWithEmby();
    await login(app, 'alice', 'bon');
    const res = await login(app, 'carol', '');
    expect(res.json().viewer).toMatchObject({ role: 'member', avatarUrl: null });
  });

  it('401 avec le message Emby sur de mauvais identifiants', async () => {
    const app = await appWithEmby();
    const res = await login(app, 'alice', 'faux');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Identifiant ou mot de passe Emby incorrect' });
    expect(res.cookies).toHaveLength(0);
  });

  it('compte désactivé sur Emby (403) : refusé, ni compte ni session créés', async () => {
    const app = await newApp();
    const emby = await serve({ 'POST /Users/AuthenticateByName': status(403) });
    setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: emby.url, apiKey: 'CLE-EMBY' });
    const res = await login(app, 'alice', 'bon');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Compte Emby désactivé ou non autorisé' });
    expect(res.cookies).toHaveLength(0);
    expect(getUser(app.data.db, 'u-1')).toBeNull();
  });

  it('409 tant qu’Emby n’est pas configuré, 400 sur un corps invalide', async () => {
    const app = await newApp();
    expect((await login(app, 'alice', 'bon')).json()).toEqual({
      error: "Aucun serveur multimédia n'est encore configuré",
    });
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { username: ' ' } });
    expect(bad.statusCode).toBe(400);
  });

  it('limite les tentatives par adresse IP', async () => {
    const app = await appWithEmby();
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < LOGIN_LIMIT.limit; i++) {
      expect((await login(app, 'alice', 'faux', from('10.0.0.1'))).statusCode).toBe(401);
    }
    const blocked = await login(app, 'alice', 'bon', from('10.0.0.1'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Trop de tentatives/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(app, 'alice', 'bon', from('10.0.0.2'))).statusCode).toBe(200);
  });

  it('un X-Forwarded-For changeant venant d’une adresse non fiable ne contourne pas la limite', async () => {
    const app = await appWithEmby();
    for (let i = 0; i < LOGIN_LIMIT.limit; i++) {
      const res = await login(app, 'alice', 'faux', { 'x-forwarded-for': `198.51.100.${i}` }, UNTRUSTED);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(app, 'alice', 'bon', { 'x-forwarded-for': '198.51.100.99' }, UNTRUSTED);
    expect(blocked.statusCode).toBe(429);
  });

  it('ignore X-Forwarded-Proto venant d’une adresse non fiable', async () => {
    const app = await appWithEmby();
    const res = await login(app, 'alice', 'bon', { 'x-forwarded-proto': 'https' }, UNTRUSTED);
    expect((sessionCookie(res) as Record<string, unknown>).secure).toBeUndefined();
  });
});

describe('session', () => {
  it('GET /api/auth/me renvoie le membre connecté et prolonge le cookie', async () => {
    const app = await newApp();
    const { headers, user } = await loginAs(app, 'manager');
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(res.json().viewer).toMatchObject({ id: user.id, role: 'manager' });
    const cookie = sessionCookie(res) as unknown as { value: string; expires: Date; httpOnly: boolean };
    expect(`request_session=${cookie.value}`).toBe(headers.cookie);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.expires.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });

  it('POST /api/auth/logout révoque la session et efface le cookie', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'member');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect(sessionCookie(out).value).toBe('');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(me.statusCode).toBe(401);
  });

  it('POST /api/auth/logout efface le cookie même sans session valide', async () => {
    const app = await newApp();
    for (const cookie of [undefined, 'request_session=inconnu.fausse-signature']) {
      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...csrf, ...(cookie && { cookie }) },
      });
      expect(out.statusCode).toBe(204);
      expect(sessionCookie(out).value).toBe('');
    }
  });
});
