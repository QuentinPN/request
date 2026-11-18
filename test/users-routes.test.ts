import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { setSetting } from '../src/server/services/settings.ts';
import { upsertFromEmby } from '../src/server/services/users.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import type { FakeRoutes } from './fake-server.ts';
import usersFixture from './fixtures/emby/users.json';
import { loginAs, loginAsOwner, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

const EMBY_KEY = 'CLE-EMBY';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function withEmby(app: FastifyInstance, routes: FakeRoutes) {
  const emby = await serve(routes);
  setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: emby.url, apiKey: EMBY_KEY });
  return emby;
}

const put = (app: FastifyInstance, id: string, payload: object, headers: Record<string, string>) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}`, headers, payload });

describe('GET /api/users', () => {
  it('ouvert aux gestionnaires, fermé aux membres', async () => {
    const app = await newApp();
    const manager = await loginAs(app, 'manager');
    const member = await loginAs(app, 'member');
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: manager.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual(
      expect.objectContaining({ id: member.user.id, role: 'member', quotaOverride: null, avatarUrl: null }),
    );
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: member.headers })).statusCode).toBe(403);
  });
});

describe('POST /api/users/import', () => {
  it('importe les comptes Emby actifs sans jamais promouvoir', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    await withEmby(app, { 'GET /Users/Query': usersFixture });
    const res = await app.inject({ method: 'POST', url: '/api/users/import', headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json() as Array<{ id: string; role: string }>).map((m) => [m.id, m]));
    expect(byId.get('u-1')).toMatchObject({ name: 'alice', role: 'member', avatarUrl: '/api/users/u-1/avatar' });
    expect(byId.get('u-3')).toMatchObject({ role: 'member', lastLoginAt: null }); // jamais connecté
    expect(byId.has('u-2')).toBe(false); // désactivé dans Emby

    // Un rôle déjà attribué survit à un nouvel import.
    await put(app, 'u-3', { role: 'manager' }, owner.headers);
    const again = await app.inject({ method: 'POST', url: '/api/users/import', headers: owner.headers });
    expect(again.json()).toContainEqual(expect.objectContaining({ id: 'u-3', role: 'manager' }));
  });

  it('réservé au propriétaire', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'manager');
    expect((await app.inject({ method: 'POST', url: '/api/users/import', headers })).statusCode).toBe(403);
  });
});

describe('PUT /api/users/:id', () => {
  it('change rôle et quotas', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const { user } = await loginAs(app, 'member');
    const quotaOverride = { movies: { limit: 2, days: 7 }, seasons: null };
    const res = await put(app, user.id, { role: 'auto_approve', quotaOverride }, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id, role: 'auto_approve', quotaOverride });
    expect((await put(app, user.id, { quotaOverride: null }, owner.headers)).json().quotaOverride).toBeNull();
  });

  it('409 pour le dernier propriétaire, 404 pour un inconnu, 403 sans le droit', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const lastOwner = await put(app, owner.user.id, { role: 'member' }, owner.headers);
    expect(lastOwner.statusCode).toBe(409);
    expect(lastOwner.json()).toEqual({ error: 'Il doit rester au moins un propriétaire' });
    expect((await put(app, 'inconnu', { role: 'member' }, owner.headers)).statusCode).toBe(404);
    const invalid = await put(app, owner.user.id, { role: 'roi' }, owner.headers);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Requête invalide' });
    const badQuota = { quotaOverride: { movies: { limit: -1, days: 7 } } };
    expect((await put(app, owner.user.id, badQuota, owner.headers)).statusCode).toBe(400);
    const manager = await loginAs(app, 'manager');
    expect((await put(app, owner.user.id, { role: 'member' }, manager.headers)).statusCode).toBe(403);
  });
});

describe('GET /api/users/:id/avatar', () => {
  it('relaie la photo Emby avec un cache privé', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'member');
    const emby = await withEmby(app, {
      'GET /Users/u-1/Images/Primary': (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      },
    });
    upsertFromEmby(app.data.db, {
      id: 'u-1',
      name: 'alice',
      avatar: '/Users/u-1/Images/Primary?tag=t',
      isEmbyAdmin: false,
    });

    const res = await app.inject({ method: 'GET', url: '/api/users/u-1/avatar', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload).toEqual(PNG);
    expect(emby.requests[0]).toMatchObject({ query: { tag: 't' }, headers: { 'x-emby-token': EMBY_KEY } });

    expect((await app.inject({ method: 'GET', url: '/api/users/u-1/avatar' })).statusCode).toBe(401);
  });

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream'])(
    '502 si Emby renvoie %s (images matricielles seulement)',
    async (type) => {
      const app = await newApp();
      const { headers } = await loginAs(app, 'member');
      await withEmby(app, {
        'GET /Users/u-1/Images/Primary': (_req, res) => {
          res.writeHead(200, { 'content-type': type });
          res.end('<svg onload="alert(1)"/>');
        },
      });
      upsertFromEmby(app.data.db, {
        id: 'u-1',
        name: 'alice',
        avatar: '/Users/u-1/Images/Primary',
        isEmbyAdmin: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/users/u-1/avatar', headers });
      expect(res.statusCode).toBe(502);
      expect(res.headers['content-type']).toContain('application/json');
    },
  );

  it('404 sans photo', async () => {
    const app = await newApp();
    const { headers, user } = await loginAs(app, 'member');
    const res = await app.inject({ method: 'GET', url: `/api/users/${user.id}/avatar`, headers });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/users/:id/sessions', () => {
  const del = (app: FastifyInstance, id: string, headers: Record<string, string>) =>
    app.inject({ method: 'DELETE', url: `/api/users/${id}/sessions`, headers });
  const me = (app: FastifyInstance, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/auth/me', headers });

  it('le propriétaire déconnecte un membre partout ; les autres sessions restent', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const member = await loginAs(app, 'member');
    const phone = await loginAs(app, 'member'); // seconde session du même membre
    const other = await loginAs(app, 'member', 'autre');
    const res = await del(app, member.user.id, owner.headers);
    expect(res.statusCode).toBe(204);
    expect((await me(app, member.headers)).statusCode).toBe(401);
    expect((await me(app, phone.headers)).statusCode).toBe(401);
    expect((await me(app, other.headers)).statusCode).toBe(200);
    expect((await me(app, owner.headers)).statusCode).toBe(200);
  });

  it('403 pour les gestionnaires et les membres, 401 sans session, 404 pour un inconnu', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const manager = await loginAs(app, 'manager');
    const member = await loginAs(app, 'member');
    expect((await del(app, member.user.id, manager.headers)).statusCode).toBe(403);
    expect((await del(app, owner.user.id, member.headers)).statusCode).toBe(403);
    expect((await del(app, member.user.id, CSRF_HEADERS)).statusCode).toBe(401);
    expect((await me(app, member.headers)).statusCode).toBe(200);
    expect((await del(app, 'inconnu', owner.headers)).statusCode).toBe(404);
  });
});
