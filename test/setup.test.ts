import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { closedPortUrl, type FakeHandler, status } from './fake-server.ts';
import librariesFixture from './fixtures/emby/libraries.json';
import systemInfoFixture from './fixtures/emby/system-info.json';
import { loginAs, loginAsOwner, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

const EMBY_KEY = 'CLE-EMBY-SECRETE';
const RADARR_KEY = 'CLE-RADARR-SECRETE';

/** Répond `body` seulement si l'en-tête `header` porte la bonne clé, sinon 401. */
const keyed =
  (header: string, key: string, body: unknown): FakeHandler =>
  (req, res) =>
    req.headers[header] === key ? status(200, body)(req, res) : status(401)(req, res);

const fakeEmby = () =>
  serve({
    'GET /System/Info': keyed('x-emby-token', EMBY_KEY, systemInfoFixture),
    'GET /Library/VirtualFolders/Query': keyed('x-emby-token', EMBY_KEY, librariesFixture),
  });

const fakeRadarr = () =>
  serve({
    'GET /api/v3/system/status': keyed('x-api-key', RADARR_KEY, { version: '5.14.0' }),
    'GET /api/v3/qualityprofile': keyed('x-api-key', RADARR_KEY, [{ id: 4, name: 'HD-1080p' }]),
    'GET /api/v3/rootfolder': keyed('x-api-key', RADARR_KEY, [{ id: 1, path: '/films', freeSpace: 1.2e12 }]),
  });

const csrf = CSRF_HEADERS;
const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
  headers: Record<string, string> = csrf,
) => app.inject({ method, url, headers, ...(payload && { payload }) });

describe('GET /api/setup/state', () => {
  it('décrit une installation neuve, puis complète', async () => {
    const app = await newApp();
    expect((await call(app, 'GET', '/api/setup/state')).json()).toEqual({
      services: { emby: false, tmdb: false, radarr: false, sonarr: false, rules: false },
      hasOwner: false,
      complete: false,
    });

    const { db, cryptoKey } = app.data;
    const service = { url: 'http://service', apiKey: 'k' };
    setSetting(db, cryptoKey, 'emby', service);
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'k' });
    setSetting(db, cryptoKey, 'radarr', { ...service, qualityProfileId: 1, rootFolderPath: '/films' });
    setSetting(db, cryptoKey, 'sonarr', { ...service, qualityProfileId: 1, rootFolderPath: '/series' });
    setSetting(db, cryptoKey, 'rules', {});
    expect((await call(app, 'GET', '/api/setup/state')).json()).toMatchObject({ hasOwner: false, complete: false });
    await loginAsOwner(app);
    expect((await call(app, 'GET', '/api/setup/state')).json()).toMatchObject({ hasOwner: true, complete: true });
  });
});

describe('amorçage', () => {
  it('Emby se teste et s’enregistre sans session tant qu’aucun propriétaire n’existe', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const test = await call(app, 'POST', '/api/setup/emby/test', { url: emby.url, apiKey: EMBY_KEY });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ serverName: 'Salon', version: '4.8.10.0' });
    expect(test.json().libraries).toContainEqual({ id: '10', name: 'Films', type: 'movies' });

    const save = await call(app, 'PUT', '/api/settings/emby', { url: emby.url, apiKey: EMBY_KEY, libraryIds: ['10'] });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ url: emby.url, apiKey: { set: true }, libraryIds: ['10'], publicUrl: null });
  });

  it('les autres services exigent une session même avant le propriétaire', async () => {
    const app = await newApp();
    expect((await call(app, 'POST', '/api/setup/radarr/test', { url: 'http://x', apiKey: 'k' })).statusCode).toBe(401);
    expect((await call(app, 'PUT', '/api/settings/rules', {})).statusCode).toBe(401);
    expect((await call(app, 'GET', '/api/settings/emby')).statusCode).toBe(401);
  });

  it('se ferme dès qu’un propriétaire existe : 401 sans session, 403 pour un membre', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const body = { url: emby.url, apiKey: EMBY_KEY };
    const owner = await loginAsOwner(app);
    const member = await loginAs(app, 'manager');
    expect((await call(app, 'POST', '/api/setup/emby/test', body)).statusCode).toBe(401);
    expect((await call(app, 'PUT', '/api/settings/emby', body)).statusCode).toBe(401);
    expect((await call(app, 'POST', '/api/setup/emby/test', body, member.headers)).statusCode).toBe(403);
    expect((await call(app, 'POST', '/api/setup/emby/test', body, owner.headers)).statusCode).toBe(200);
  });
});

describe('adresse publique d’Emby', () => {
  const put = async (publicUrl?: unknown) => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby();
    const body = { url: emby.url, apiKey: EMBY_KEY, ...(publicUrl !== undefined && { publicUrl }) };
    return { app, headers, res: await call(app, 'PUT', '/api/settings/emby', body, headers) };
  };

  it('s’enregistre sans « / » final et se relit en clair (ce n’est pas un secret)', async () => {
    const { app, headers, res } = await put('https://tv.exemple.fr/emby/');
    expect(res.statusCode).toBe(200);
    expect(res.json().publicUrl).toBe('https://tv.exemple.fr/emby');
    const read = await call(app, 'GET', '/api/settings/emby', undefined, headers);
    expect(read.json().publicUrl).toBe('https://tv.exemple.fr/emby');
    expect(getSetting(app.data.db, app.data.cryptoKey, 'emby')?.publicUrl).toBe('https://tv.exemple.fr/emby');
  });

  it('est facultative : absente ou nulle', async () => {
    expect((await put()).res.json().publicUrl).toBeNull();
    expect((await put(null)).res.json().publicUrl).toBeNull();
  });

  it('refuse une adresse qui n’est pas http(s)', async () => {
    for (const bad of ['emby.exemple.fr', 'ftp://emby.exemple.fr', 'javascript:alert(1)', ''])
      expect((await put(bad)).res.statusCode, bad).toBe(400);
  });
});

describe('POST /api/setup/:service/test', () => {
  it('422 avec le message lisible du service', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby();
    const wrongKey = await call(app, 'POST', '/api/setup/emby/test', { url: emby.url, apiKey: 'faux' }, headers);
    expect(wrongKey.statusCode).toBe(422);
    expect(wrongKey.json()).toEqual({ error: "Clé d'API refusée par Emby" });

    const down = await call(
      app,
      'POST',
      '/api/setup/radarr/test',
      { url: await closedPortUrl(), apiKey: 'k' },
      headers,
    );
    expect(down.statusCode).toBe(422);
    expect(down.json()).toEqual({ error: 'Radarr injoignable à cette adresse' });
  });

  it('renvoie profils et dossiers de Radarr', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const radarr = await fakeRadarr();
    const res = await call(app, 'POST', '/api/setup/radarr/test', { url: radarr.url, apiKey: RADARR_KEY }, headers);
    expect(res.json()).toEqual({
      version: '5.14.0',
      qualityProfiles: [{ id: 4, name: 'HD-1080p' }],
      rootFolders: [{ id: 1, path: '/films', freeSpace: 1.2e12 }],
    });
  });

  it('une clé vide réutilise la clé enregistrée, à la même adresse seulement', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby();
    setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: emby.url, apiKey: EMBY_KEY });

    const reused = await call(app, 'POST', '/api/setup/emby/test', { url: `${emby.url}/`, apiKey: '' }, headers);
    expect(reused.statusCode).toBe(200);
    expect(emby.requests.at(-1)?.headers['x-emby-token']).toBe(EMBY_KEY);

    // Autre adresse : la clé enregistrée n'est jamais envoyée ailleurs.
    const other = await fakeEmby();
    const elsewhere = await call(app, 'POST', '/api/setup/emby/test', { url: other.url, apiKey: '' }, headers);
    expect(elsewhere.statusCode).toBe(400);
    expect(other.requests).toHaveLength(0);
  });

  it('404 pour un service inconnu ou sans test', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    expect((await call(app, 'POST', '/api/setup/rules/test', {}, headers)).statusCode).toBe(404);
    expect((await call(app, 'POST', '/api/setup/plex/test', {}, headers)).statusCode).toBe(404);
  });
});

describe('réglages', () => {
  it('PUT teste puis enregistre ; GET ne renvoie jamais le secret', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const radarr = await fakeRadarr();
    const body = { url: radarr.url, apiKey: RADARR_KEY, qualityProfileId: 4, rootFolderPath: '/films' };

    const incomplete = await call(app, 'PUT', '/api/settings/radarr', { url: radarr.url, apiKey: RADARR_KEY }, headers);
    expect(incomplete.statusCode).toBe(400);
    const refused = await call(app, 'PUT', '/api/settings/radarr', { ...body, apiKey: 'faux' }, headers);
    expect(refused.statusCode).toBe(422);
    expect((await call(app, 'GET', '/api/settings/radarr', undefined, headers)).statusCode).toBe(404);

    const saved = await call(app, 'PUT', '/api/settings/radarr', body, headers);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(RADARR_KEY);

    const read = await call(app, 'GET', '/api/settings/radarr', undefined, headers);
    expect(read.body).not.toContain(RADARR_KEY);
    expect(read.json()).toEqual({ ...body, apiKey: { set: true }, minimumAvailability: 'released' });

    // Modifier sans renvoyer la clé : l'ancienne est gardée.
    const updated = await call(
      app,
      'PUT',
      '/api/settings/radarr',
      { ...body, apiKey: '', rootFolderPath: '/4k' },
      headers,
    );
    expect(updated.json()).toMatchObject({ rootFolderPath: '/4k', apiKey: { set: true } });
    expect(radarr.requests.at(-1)?.headers['x-api-key']).toBe(RADARR_KEY);
  });

  it('règles : valeurs par défaut puis enregistrement', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const defaults = await call(app, 'GET', '/api/settings/rules', undefined, headers);
    expect(defaults.json()).toEqual({
      defaultQuota: { movies: { limit: 10, days: 7 }, seasons: { limit: 10, days: 7 } },
    });
    const rules = { defaultQuota: { movies: { limit: 3, days: 30 }, seasons: { limit: 5, days: 7 } } };
    expect((await call(app, 'PUT', '/api/settings/rules', rules, headers)).json()).toEqual(rules);
    expect((await call(app, 'GET', '/api/setup/state')).json().services.rules).toBe(true);
    const invalid = { defaultQuota: { movies: { limit: -1, days: 7 } } };
    expect((await call(app, 'PUT', '/api/settings/rules', invalid, headers)).statusCode).toBe(400);
  });
});
