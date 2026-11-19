import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/server/crypto.ts';
import { sessions } from '../src/server/db/schema.ts';
import { BEARER_LIMIT } from '../src/server/plugins/auth.ts';
import { SESSION_REFRESH_MS, SESSION_TTL_MS, summarizeUserAgent } from '../src/server/services/sessions.ts';
import { API_KEYS_PATH, type ApiKeyCreated } from '../src/shared/api-keys.ts';
import {
  AUTH_SESSIONS_PATH,
  authSessionPath,
  authSessionsSchema,
  LOGOUT_PATH,
  userPath,
  VIEWER_PATH,
} from '../src/shared/auth.ts';
import { REQUEST_BATCH_PATH } from '../src/shared/requests.ts';
import { bearerAs, loginAs, loginAsOwner, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();
const UNTRUSTED = '203.0.113.9';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

type Headers = Record<string, string>;

const me = (app: FastifyInstance, headers: Headers, remoteAddress?: string) =>
  app.inject({ method: 'GET', url: VIEWER_PATH, headers, ...(remoteAddress && { remoteAddress }) });

const declineMissing = (app: FastifyInstance, headers: Headers) =>
  app.inject({
    method: 'POST',
    url: REQUEST_BATCH_PATH,
    headers,
    payload: { action: 'decline', ids: [999], reason: 'Test' },
  });

const sessionRow = (app: FastifyInstance, token: string) =>
  app.data.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sha256Hex(token)))
    .get();

async function listSessions(app: FastifyInstance, headers: Headers) {
  const res = await app.inject({ method: 'GET', url: AUTH_SESSIONS_PATH, headers });
  expect(res.statusCode).toBe(200);
  return authSessionsSchema.parse(res.json()).sessions;
}

const revoke = (app: FastifyInstance, headers: Headers, id: string) =>
  app.inject({ method: 'DELETE', url: authSessionPath(id), headers });

describe('Authorization: Bearer', () => {
  it('ouvre les routes membres avec le rôle réel du membre, sans poser de cookie', async () => {
    const app = await newApp();
    const member = await bearerAs(app, 'member');
    const res = await me(app, member.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().viewer).toMatchObject({ id: member.user.id, role: 'member' });
    expect(res.headers['set-cookie']).toBeUndefined();
    // Pas les droits du propriétaire, contrairement à une clé d'API : route de gestionnaire refusée.
    expect((await declineMissing(app, member.headers)).statusCode).toBe(403);
  });

  it('accepte une écriture sans X-Request, même depuis une origine étrangère', async () => {
    const app = await newApp();
    const manager = await bearerAs(app, 'manager');
    const res = await declineMissing(app, { ...manager.headers, origin: 'https://autre-site.example' });
    expect(res.statusCode).toBe(200);
  });

  it('ouvre le relais d’images (/api/images)', async () => {
    const tmdb = await serve({
      'GET /w342/a.png': (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      },
    });
    const app = await newApp({ upstreams: { imagesUrl: tmdb.url } });
    const member = await bearerAs(app, 'member');
    const url = '/api/images/w342/a.png';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url, headers: member.headers });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it('un propriétaire en Bearer ne gère pas les clés d’API (403) : un jeton volé ne doit pas en créer une', async () => {
    const app = await newApp();
    const owner = await bearerAs(app, 'owner', 'proprietaire');
    expect((await app.inject({ method: 'GET', url: API_KEYS_PATH, headers: owner.headers })).statusCode).toBe(403);
    const payload = { name: 'k' };
    const created = await app.inject({ method: 'POST', url: API_KEYS_PATH, headers: owner.headers, payload });
    expect(created.statusCode).toBe(403);
  });

  it('refuse Bearer avec un cookie de session ou une clé d’API (400), même valides, sans repli', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const bearer = await bearerAs(app, 'member');
    const created = await app.inject({
      method: 'POST',
      url: API_KEYS_PATH,
      headers: owner.headers,
      payload: { name: 'k' },
    });
    const key = created.json<ApiKeyCreated>().secret;
    const mixes: Headers[] = [
      { ...owner.headers, ...bearer.headers },
      // Cookie seul, sans en-tête CSRF : le mélange est refusé avant tout contrôle CSRF.
      { cookie: owner.headers.cookie ?? '', authorization: 'Bearer faux' },
      { ...bearer.headers, 'x-api-key': key },
      { ...owner.headers, authorization: 'Bearer faux' },
      { authorization: 'Bearer faux', 'x-api-key': key },
    ];
    for (const headers of mixes)
      expect((await me(app, headers)).statusCode, JSON.stringify(Object.keys(headers))).toBe(400);
  });

  it('refuse un jeton Bearer inconnu, vide ou malformé (401), routes publiques comprises', async () => {
    const app = await newApp();
    const { token } = await bearerAs(app, 'member');
    let n = 0;
    for (const authorization of [
      'Bearer inconnu',
      'Bearer ',
      'Bearer',
      `Bearer ${token} x`,
      `Bearer  ${token}`,
      `Bearer "${token}"`,
    ])
      for (const url of [VIEWER_PATH, '/api/health']) {
        // Une adresse par essai : ce test ne vise pas la limite.
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization },
          remoteAddress: `198.51.100.${n++}`,
        });
        expect(res.statusCode, `${url} « ${authorization} »`).toBe(401);
      }
    // Schéma sans casse (RFC 7235).
    expect((await me(app, { authorization: `bearer ${token}` })).statusCode).toBe(200);
  });

  it('ignore les autres schémas (Basic…) : cookie conservé, route publique normale, sinon 401 hors limiteur', async () => {
    const app = await newApp();
    const member = await loginAs(app, 'member');
    const basic = { authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}` };
    expect((await me(app, { ...member.headers, ...basic })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: basic })).statusCode).toBe(200);
    for (let i = 0; i <= BEARER_LIMIT.limit; i++) expect((await me(app, basic, UNTRUSTED)).statusCode).toBe(401);
    // Jamais compté : un Bearer invalide de la même adresse n'est pas encore bloqué.
    expect((await me(app, { authorization: 'Bearer faux' }, UNTRUSTED)).statusCode).toBe(401);
  });

  it('refuse un jeton expiré (401), sans repli sur le cookie', async () => {
    const app = await newApp();
    const expired = await bearerAs(app, 'member');
    app.data.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sha256Hex(expired.token)))
      .run();
    expect((await me(app, expired.headers)).statusCode).toBe(401);
  });

  it('prolonge l’expiration comme le cookie (glissante, au plus une écriture par heure)', async () => {
    const app = await newApp();
    const active = await bearerAs(app, 'member');
    const old = new Date(Date.now() - SESSION_REFRESH_MS - 1000);
    app.data.db
      .update(sessions)
      .set({ lastSeenAt: old, expiresAt: new Date(old.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, sha256Hex(active.token)))
      .run();
    expect((await me(app, active.headers)).statusCode).toBe(200);
    const row = sessionRow(app, active.token);
    expect(row?.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });

  it('ne lit jamais le jeton dans l’adresse (?token=, ?access_token=)', async () => {
    const app = await newApp();
    const { token } = await bearerAs(app, 'member');
    for (const param of ['token', 'access_token']) {
      const res = await app.inject({ method: 'GET', url: `${VIEWER_PATH}?${param}=${token}` });
      expect(res.statusCode, param).toBe(401);
    }
  });

  it('limite les jetons invalides par IP : 429 avec Retry-After, un jeton valide passe toujours', async () => {
    const app = await newApp();
    const member = await bearerAs(app, 'member');
    for (let i = 0; i < BEARER_LIMIT.limit; i++)
      expect((await me(app, { authorization: `Bearer faux${i}` }, UNTRUSTED)).statusCode).toBe(401);
    const blocked = await me(app, { authorization: 'Bearer faux' }, UNTRUSTED);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await me(app, { authorization: 'Bearer' }, UNTRUSTED)).statusCode).toBe(429);
    expect((await me(app, member.headers, UNTRUSTED)).statusCode).toBe(200);
    // Compteur propre aux jetons : les clés d'API de cette adresse ne sont pas bloquées.
    expect((await me(app, { 'x-api-key': 'ur_faux' }, UNTRUSTED)).statusCode).toBe(401);
  });
});

describe('sessions du membre (GET et DELETE /api/auth/sessions)', () => {
  it('liste ses sessions, navigateur et appareils, sans jeton ni empreinte', async () => {
    const app = await newApp();
    const tv = await bearerAs(app, 'member', 'alice', 'Salon');
    const browser = await loginAs(app, 'member', 'alice');
    await bearerAs(app, 'member', 'bob', 'Télé de Bob');

    const res = await app.inject({ method: 'GET', url: AUTH_SESSIONS_PATH, headers: tv.headers });
    const list = authSessionsSchema.parse(res.json()).sessions;
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.current)).toMatchObject({ deviceName: 'Salon', userAgent: 'okhttp/4.12.0' });
    expect(list.find((s) => !s.current)).toMatchObject({ deviceName: null, userAgent: null });
    expect(list[0]?.id).toMatch(/^[0-9a-f]{32}$/);
    const hash = sha256Hex(tv.token);
    for (const secret of [tv.token, hash.slice(0, 16), hash.slice(-16)]) expect(res.body).not.toContain(secret);

    // Par cookie : la session courante est celle du navigateur.
    const byCookie = await listSessions(app, browser.headers);
    expect(byCookie.find((s) => s.current)?.deviceName).toBeNull();
    expect(byCookie.map((s) => s.id).sort()).toEqual(list.map((s) => s.id).sort());
  });

  it('révoque l’une de ses sessions (cookie ou Bearer), jamais celle d’un autre (404)', async () => {
    const app = await newApp();
    const tv = await bearerAs(app, 'member', 'alice', 'Salon');
    const phone = await bearerAs(app, 'member', 'alice', 'Téléphone');
    const bob = await bearerAs(app, 'member', 'bob', 'Télé de Bob');
    const browser = await loginAs(app, 'member', 'alice');
    const idOf = async (deviceName: string) =>
      (await listSessions(app, tv.headers)).find((s) => s.deviceName === deviceName)?.id ?? '';

    const bobId = (await listSessions(app, bob.headers))[0]?.id ?? '';
    expect((await revoke(app, tv.headers, bobId)).statusCode).toBe(404);
    expect((await me(app, bob.headers)).statusCode).toBe(200);
    expect((await revoke(app, tv.headers, 'pas-un-id')).statusCode).toBe(400);

    expect((await revoke(app, tv.headers, await idOf('Téléphone'))).statusCode).toBe(204);
    expect((await me(app, phone.headers)).statusCode).toBe(401);
    expect((await me(app, tv.headers)).statusCode).toBe(200);

    // Depuis le navigateur (cookie et en-tête CSRF), l'appareil du salon.
    expect((await revoke(app, browser.headers, await idOf('Salon'))).statusCode).toBe(204);
    expect((await me(app, tv.headers)).statusCode).toBe(401);
    expect((await me(app, browser.headers)).statusCode).toBe(200);
  });

  it('une session expirée est introuvable (404), comme la liste qui la masque', async () => {
    const app = await newApp();
    const tv = await bearerAs(app, 'member', 'alice', 'Salon');
    const phone = await bearerAs(app, 'member', 'alice', 'Téléphone');
    const id = (await listSessions(app, tv.headers)).find((s) => s.deviceName === 'Téléphone')?.id ?? '';
    app.data.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sha256Hex(phone.token)))
      .run();
    expect((await revoke(app, tv.headers, id)).statusCode).toBe(404);
    expect(sessionRow(app, phone.token)).toBeDefined();
  });

  it('une clé d’API ne liste ni ne révoque de session (403)', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const created = await app.inject({
      method: 'POST',
      url: API_KEYS_PATH,
      headers: owner.headers,
      payload: { name: 'k' },
    });
    const headers = { 'x-api-key': created.json<ApiKeyCreated>().secret };
    const ownerId = (await listSessions(app, owner.headers))[0]?.id ?? '';
    expect((await app.inject({ method: 'GET', url: AUTH_SESSIONS_PATH, headers })).statusCode).toBe(403);
    expect((await revoke(app, headers, ownerId)).statusCode).toBe(403);
    expect((await me(app, owner.headers)).statusCode).toBe(200);
  });
});

describe('déconnexion', () => {
  it('POST /api/auth/logout en Bearer révoque la session du jeton seulement', async () => {
    const app = await newApp();
    const tv = await bearerAs(app, 'member', 'alice');
    const browser = await loginAs(app, 'member', 'alice');
    const res = await app.inject({ method: 'POST', url: LOGOUT_PATH, headers: tv.headers });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessionRow(app, tv.token)).toBeUndefined();
    expect((await me(app, tv.headers)).statusCode).toBe(401);
    expect((await me(app, browser.headers)).statusCode).toBe(200);
  });

  it('POST /api/auth/logout par cookie révoque la session du cookie et l’efface', async () => {
    const app = await newApp();
    const tv = await bearerAs(app, 'member', 'alice');
    const browser = await loginAs(app, 'member', 'alice');
    const res = await app.inject({ method: 'POST', url: LOGOUT_PATH, headers: browser.headers });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('request_session=;');
    expect((await me(app, browser.headers)).statusCode).toBe(401);
    expect((await me(app, tv.headers)).statusCode).toBe(200);
  });

  it('« Déconnecter partout » par le propriétaire révoque aussi les jetons Bearer', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const tv = await bearerAs(app, 'member', 'alice');
    const res = await app.inject({ method: 'DELETE', url: userPath('alice', 'sessions'), headers: owner.headers });
    expect(res.statusCode).toBe(204);
    expect((await me(app, tv.headers)).statusCode).toBe(401);
  });
});

describe('summarizeUserAgent', () => {
  it('résume navigateur et système, sinon le premier produit', () => {
    expect(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe(
      'Firefox · Windows',
    );
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
      ),
    ).toBe('Edge · macOS');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS');
    expect(summarizeUserAgent('okhttp/4.12.0')).toBe('okhttp/4.12.0');
    expect(summarizeUserAgent(null)).toBeNull();
    expect(summarizeUserAgent('  ')).toBeNull();
  });
});
