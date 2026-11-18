import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceSetupToken, parseSetupToken, SETUP_TOKEN_LIMIT } from '../src/server/plugins/auth.ts';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { SETUP_TOKEN_HEADER } from '../src/shared/setup.ts';
import { type FakeHandler, status } from './fake-server.ts';
import librariesFixture from './fixtures/emby/libraries.json';
import systemInfoFixture from './fixtures/emby/system-info.json';
import { addArrServer, bootstrapHeaders, loginAs, loginAsOwner, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

const EMBY_KEY = 'CLE-EMBY-SECRETE';

/** Répond `body` seulement si l'en-tête `header` porte la bonne clé, sinon 401. */
const keyed =
  (header: string, key: string, body: unknown): FakeHandler =>
  (req, res) =>
    req.headers[header] === key ? status(200, body)(req, res) : status(401)(req, res);

/** Faux Emby ; `serverId` : id de l'instance (`Id` de `/System/Info`), celui de la fixture par défaut. */
const fakeEmby = (serverId = systemInfoFixture.Id) =>
  serve({
    'GET /System/Info': keyed('x-emby-token', EMBY_KEY, { ...systemInfoFixture, Id: serverId }),
    'GET /Library/VirtualFolders/Query': keyed('x-emby-token', EMBY_KEY, librariesFixture),
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
      services: { mediaServer: false, tmdb: false, radarr: false, sonarr: false, rules: false },
      mediaServerKind: null,
      hasOwner: false,
      hasMembers: false,
      complete: false,
      appTitle: 'Request',
    });

    const { db, cryptoKey } = app.data;
    const service = { url: 'http://service', apiKey: 'k' };
    setSetting(db, cryptoKey, 'emby', service);
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'k' });
    addArrServer(app.data, { ...service, type: 'radarr' });
    addArrServer(app.data, { ...service, type: 'sonarr' });
    setSetting(db, cryptoKey, 'rules', {});
    expect((await call(app, 'GET', '/api/setup/state')).json()).toMatchObject({ hasOwner: false, complete: false });
    await loginAsOwner(app);
    expect((await call(app, 'GET', '/api/setup/state')).json()).toMatchObject({
      hasOwner: true,
      hasMembers: true,
      complete: true,
    });
  });

  it('des membres sans propriétaire : `hasMembers` suit la règle serveur du type figé', async () => {
    const app = await newApp();
    await loginAs(app, 'member');
    expect((await call(app, 'GET', '/api/setup/state')).json()).toMatchObject({ hasOwner: false, hasMembers: true });
  });
});

describe('amorçage', () => {
  it('Emby se teste et s’enregistre sans session avec le jeton d’installation', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const headers = bootstrapHeaders(app);
    const test = await call(
      app,
      'POST',
      '/api/setup/mediaServer/test',
      { kind: 'emby', url: emby.url, apiKey: EMBY_KEY },
      headers,
    );
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ serverName: 'Salon', version: '4.8.10.0' });
    expect(test.json().libraries).toContainEqual({ id: '10', name: 'Films', type: 'movies' });

    const save = await call(
      app,
      'PUT',
      '/api/settings/mediaServer',
      { kind: 'emby', url: emby.url, apiKey: EMBY_KEY, libraryIds: ['10'] },
      headers,
    );
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      kind: 'emby',
      url: emby.url,
      apiKey: { set: true },
      libraryIds: ['10'],
      publicUrl: null,
      serverId: systemInfoFixture.Id,
    });
  });

  it('sans jeton, ou avec un faux : 403 et rien n’est contacté ni enregistré', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const body = { kind: 'emby', url: emby.url, apiKey: EMBY_KEY };
    for (const headers of [csrf, { ...csrf, [SETUP_TOKEN_HEADER]: 'faux' }, { ...csrf, [SETUP_TOKEN_HEADER]: '' }]) {
      const test = await call(app, 'POST', '/api/setup/mediaServer/test', body, headers);
      expect(test.statusCode).toBe(403);
      expect(test.json().error).toMatch(/^Jeton d’installation manquant ou invalide/);
      expect((await call(app, 'PUT', '/api/settings/mediaServer', body, headers)).statusCode).toBe(403);
    }
    expect(emby.requests).toHaveLength(0);
    expect(getSetting(app.data.db, app.data.cryptoKey, 'mediaServer')).toBeNull();
  });

  it('une session sans droit ne remplace pas le jeton (membre inscrit avant le propriétaire)', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const member = await loginAs(app, 'manager');
    const body = { kind: 'emby', url: emby.url, apiKey: EMBY_KEY };
    expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, member.headers)).statusCode).toBe(403);
    const withToken = { ...member.headers, [SETUP_TOKEN_HEADER]: app.setupToken };
    expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, withToken)).statusCode).toBe(200);
  });

  it('jetons invalides limités par adresse IP (429), même le bon jeton est refusé jusqu’à la fin de la fenêtre', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const body = { kind: 'emby', url: emby.url, apiKey: EMBY_KEY };
    const wrong = { ...csrf, [SETUP_TOKEN_HEADER]: 'faux' };
    for (let i = 0; i < SETUP_TOKEN_LIMIT.limit; i++)
      expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, wrong)).statusCode).toBe(403);
    const blocked = await call(app, 'POST', '/api/setup/mediaServer/test', body, wrong);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, bootstrapHeaders(app))).statusCode).toBe(429);
  });

  describe('annonce du jeton', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('le jeton aléatoire est écrit dans les journaux, pas celui de `SETUP_TOKEN`', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const app = await newApp();
      announceSetupToken(app);
      expect(log).toHaveBeenCalledWith(`Jeton d’installation : ${app.setupToken}`);
      log.mockClear();
      vi.stubEnv('SETUP_TOKEN', app.setupToken);
      announceSetupToken(app);
      expect(log).toHaveBeenCalledWith('Jeton d’installation : celui de la variable SETUP_TOKEN.');
    });
  });

  it('jeton : `SETUP_TOKEN` s’il est renseigné, sinon tiré au hasard', () => {
    expect(parseSetupToken('  mon-jeton  ')).toBe('mon-jeton');
    for (const env of [undefined, '', '   ']) expect(parseSetupToken(env)).toMatch(/^[\w-]{32}$/);
    expect(parseSetupToken(undefined)).not.toBe(parseSetupToken(undefined));
  });

  it('les autres services exigent une session même avant le propriétaire', async () => {
    const app = await newApp();
    expect((await call(app, 'POST', '/api/setup/radarr/test', { url: 'http://x', apiKey: 'k' })).statusCode).toBe(401);
    expect((await call(app, 'PUT', '/api/settings/rules', {})).statusCode).toBe(401);
    expect((await call(app, 'GET', '/api/settings/mediaServer')).statusCode).toBe(401);
  });

  it('se ferme dès qu’un propriétaire existe, jeton ou non : 401 sans session, 403 pour un membre', async () => {
    const app = await newApp();
    const emby = await fakeEmby();
    const body = { kind: 'emby', url: emby.url, apiKey: EMBY_KEY };
    const owner = await loginAsOwner(app);
    const member = await loginAs(app, 'manager');
    for (const headers of [csrf, bootstrapHeaders(app)]) {
      expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, headers)).statusCode).toBe(401);
      expect((await call(app, 'PUT', '/api/settings/mediaServer', body, headers)).statusCode).toBe(401);
    }
    expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, member.headers)).statusCode).toBe(403);
    expect((await call(app, 'POST', '/api/setup/mediaServer/test', body, owner.headers)).statusCode).toBe(200);
  });
});

describe('instance du serveur multimédia figée une fois des membres inscrits', () => {
  const OTHER_INSTANCE = 'Ce serveur n’est pas le même que celui où vos membres sont inscrits.';
  const put = (app: FastifyInstance, url: string, headers: Record<string, string>, extra: object = {}) =>
    call(app, 'PUT', '/api/settings/mediaServer', { kind: 'emby', url, apiKey: EMBY_KEY, ...extra }, headers);
  const stored = (app: FastifyInstance) => getSetting(app.data.db, app.data.cryptoKey, 'mediaServer');

  it('l’id de l’instance vient du test, jamais du client', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby('instance-a');
    const res = await put(app, emby.url, headers, { serverId: 'choisi-par-le-client' });
    expect(res.statusCode).toBe(200);
    expect(stored(app)?.serverId).toBe('instance-a');
  });

  it('autre instance refusée (409), rien n’est modifié ; même instance à une autre adresse acceptée', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const first = await fakeEmby('instance-a');
    expect((await put(app, first.url, headers)).statusCode).toBe(200);

    const other = await fakeEmby('instance-b');
    const refused = await put(app, other.url, headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(OTHER_INSTANCE);
    expect(stored(app)).toMatchObject({ url: first.url, serverId: 'instance-a' });

    const moved = await fakeEmby('instance-a');
    expect((await put(app, moved.url, headers)).statusCode).toBe(200);
    expect(stored(app)).toMatchObject({ url: moved.url, serverId: 'instance-a' });
  });

  it('installation sans id enregistré : acceptée, l’id est enregistré au passage', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: 'http://ancien', apiKey: EMBY_KEY });
    const emby = await fakeEmby('instance-a');
    expect((await put(app, emby.url, headers)).statusCode).toBe(200);
    expect(stored(app)?.serverId).toBe('instance-a');
    expect((await put(app, (await fakeEmby('instance-b')).url, headers)).statusCode).toBe(409);
  });

  it('libre tant qu’aucun membre n’existe', async () => {
    const app = await newApp();
    const headers = bootstrapHeaders(app);
    expect((await put(app, (await fakeEmby('instance-a')).url, headers)).statusCode).toBe(200);
    expect((await put(app, (await fakeEmby('instance-b')).url, headers)).statusCode).toBe(200);
    expect(stored(app)?.serverId).toBe('instance-b');
  });
});

describe('adresse publique d’Emby', () => {
  const put = async (publicUrl?: unknown) => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby();
    const body = { kind: 'emby', url: emby.url, apiKey: EMBY_KEY, ...(publicUrl !== undefined && { publicUrl }) };
    return { app, headers, res: await call(app, 'PUT', '/api/settings/mediaServer', body, headers) };
  };

  it('s’enregistre sans « / » final et se relit en clair (ce n’est pas un secret)', async () => {
    const { app, headers, res } = await put('https://tv.exemple.fr/emby/');
    expect(res.statusCode).toBe(200);
    expect(res.json().publicUrl).toBe('https://tv.exemple.fr/emby');
    const read = await call(app, 'GET', '/api/settings/mediaServer', undefined, headers);
    expect(read.json().publicUrl).toBe('https://tv.exemple.fr/emby');
    expect(getSetting(app.data.db, app.data.cryptoKey, 'mediaServer')?.publicUrl).toBe('https://tv.exemple.fr/emby');
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
    const wrongKey = await call(
      app,
      'POST',
      '/api/setup/mediaServer/test',
      { kind: 'emby', url: emby.url, apiKey: 'faux' },
      headers,
    );
    expect(wrongKey.statusCode).toBe(422);
    expect(wrongKey.json()).toEqual({ error: "Clé d'API refusée par Emby" });
  });

  it('une clé vide réutilise la clé enregistrée, à la même adresse seulement', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const emby = await fakeEmby();
    setSetting(app.data.db, app.data.cryptoKey, 'emby', { url: emby.url, apiKey: EMBY_KEY });

    const reused = await call(
      app,
      'POST',
      '/api/setup/mediaServer/test',
      { kind: 'emby', url: `${emby.url}/`, apiKey: '' },
      headers,
    );
    expect(reused.statusCode).toBe(200);
    expect(emby.requests.at(-1)?.headers['x-emby-token']).toBe(EMBY_KEY);

    // Autre adresse : la clé enregistrée n'est jamais envoyée ailleurs.
    const other = await fakeEmby();
    const elsewhere = await call(
      app,
      'POST',
      '/api/setup/mediaServer/test',
      { kind: 'emby', url: other.url, apiKey: '' },
      headers,
    );
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
  it('Radarr et Sonarr ne sont plus des réglages : ce sont des serveurs (`/api/arr-servers`)', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    for (const kind of ['radarr', 'sonarr']) {
      expect((await call(app, 'GET', `/api/settings/${kind}`, undefined, headers)).statusCode).toBe(404);
      expect((await call(app, 'PUT', `/api/settings/${kind}`, {}, headers)).statusCode).toBe(404);
      expect((await call(app, 'POST', `/api/setup/${kind}/test`, {}, headers)).statusCode).toBe(404);
    }
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
