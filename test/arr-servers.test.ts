import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { encrypt } from '../src/server/crypto.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { adoptLegacyArrSettings, listArrServers } from '../src/server/services/arr-servers.ts';
import { ARR_SERVERS_PATH, ARR_SERVERS_TEST_PATH, type ArrServer } from '../src/shared/arr-servers.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { closedPortUrl, type FakeHandler, status } from './fake-server.ts';
import { fakeTagRoutes } from './fake-tags.ts';
import { addArrServer, loginAs, loginAsOwner, trackApps, trackFakeServers, trackTempDirs } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();
const tempDir = trackTempDirs();

const KEY = 'CLE-RADARR-SECRETE';

/** Répond `body` seulement avec la bonne clé, sinon 401. */
const keyed =
  (body: unknown): FakeHandler =>
  (req, res) =>
    req.headers['x-api-key'] === KEY ? status(200, body)(req, res) : status(401)(req, res);

const fakeArr = () =>
  serve({
    'GET /api/v3/system/status': keyed({ version: '5.14.0' }),
    'GET /api/v3/qualityprofile': keyed([
      { id: 4, name: 'HD-1080p' },
      { id: 7, name: 'Ultra-HD' },
    ]),
    'GET /api/v3/rootfolder': keyed([{ id: 1, path: '/films', freeSpace: 1.2e12 }]),
  });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (app: FastifyInstance, method: Method, url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, ...(payload && { payload }) });

async function setup() {
  const app = await newApp();
  const { headers } = await loginAsOwner(app);
  const arr = await fakeArr();
  const body = (patch: object = {}) => ({
    type: 'radarr',
    name: 'Radarr',
    url: arr.url,
    apiKey: KEY,
    qualityProfileId: 4,
    rootFolderPath: '/films',
    ...patch,
  });
  const send = (method: Method, url: string, payload?: object) => call(app, method, url, headers, payload);
  return { app, arr, body, send };
}

describe('serveurs Radarr/Sonarr', () => {
  it('propriétaire seulement : 401 sans session, 403 pour un gestionnaire', async () => {
    const app = await newApp();
    expect((await call(app, 'GET', ARR_SERVERS_PATH, CSRF_HEADERS)).statusCode).toBe(401);
    const { headers } = await loginAs(app, 'manager');
    for (const [method, url] of [
      ['GET', ARR_SERVERS_PATH],
      ['POST', ARR_SERVERS_PATH],
      ['POST', ARR_SERVERS_TEST_PATH],
      ['PUT', `${ARR_SERVERS_PATH}/1`],
      ['DELETE', `${ARR_SERVERS_PATH}/1`],
    ] as const)
      expect((await call(app, method, url, headers, {})).statusCode, `${method} ${url}`).toBe(403);
  });

  it('test en direct : profils et dossiers, 422 lisible, clé enregistrée reprise à la même adresse seulement', async () => {
    const { arr, body, send } = await setup();
    const ok = await send('POST', ARR_SERVERS_TEST_PATH, { type: 'radarr', url: arr.url, apiKey: KEY });
    expect(ok.json()).toEqual({
      version: '5.14.0',
      qualityProfiles: [
        { id: 4, name: 'HD-1080p' },
        { id: 7, name: 'Ultra-HD' },
      ],
      rootFolders: [{ id: 1, path: '/films', freeSpace: 1.2e12 }],
    });
    const down = await send('POST', ARR_SERVERS_TEST_PATH, { type: 'radarr', url: await closedPortUrl(), apiKey: 'k' });
    expect(down.statusCode).toBe(422);
    expect(down.json()).toEqual({ error: 'Radarr injoignable à cette adresse' });

    const { id } = (await send('POST', ARR_SERVERS_PATH, body())).json<ArrServer>();
    const reused = await send('POST', ARR_SERVERS_TEST_PATH, { id, type: 'radarr', url: `${arr.url}/`, apiKey: '' });
    expect(reused.statusCode).toBe(200);
    expect(arr.requests.at(-1)?.headers['x-api-key']).toBe(KEY);
    const other = await fakeArr();
    const elsewhere = await send('POST', ARR_SERVERS_TEST_PATH, { id, type: 'radarr', url: other.url, apiKey: '' });
    expect(elsewhere.statusCode).toBe(400);
    expect(other.requests).toHaveLength(0);
  });

  it('ajout : testé puis enregistré, clé jamais renvoyée ; refus sans rien écrire', async () => {
    const { app, body, send } = await setup();
    expect((await send('POST', ARR_SERVERS_PATH, body({ rootFolderPath: undefined }))).statusCode).toBe(400);
    expect((await send('POST', ARR_SERVERS_PATH, body({ apiKey: 'faux' }))).statusCode).toBe(422);
    expect((await send('GET', ARR_SERVERS_PATH)).json()).toEqual([]);
    expect((await call(app, 'GET', '/api/setup/state', CSRF_HEADERS)).json().services.radarr).toBe(false);

    const created = await send('POST', ARR_SERVERS_PATH, body());
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(KEY);
    // Premier serveur de son couple (Radarr, non 4K) : serveur par défaut, même sans le demander.
    expect(created.json()).toEqual({
      id: 1,
      type: 'radarr',
      name: 'Radarr',
      url: body().url,
      apiKey: { set: true },
      is4k: false,
      isDefault: true,
      qualityProfileId: 4,
      rootFolderPath: '/films',
      minimumAvailability: 'released',
      seriesType: null,
      languageProfileId: null,
      tags: [],
      tagRequester: false,
      searchOnAdd: true,
      externalUrl: null,
      animeQualityProfileId: null,
      animeRootFolderPath: null,
      animeSeriesType: null,
      animeLanguageProfileId: null,
      animeTags: [],
    } satisfies ArrServer);
    const list = await send('GET', ARR_SERVERS_PATH);
    expect(list.body).not.toContain(KEY);
    expect(list.json()).toEqual([created.json()]);
    expect((await call(app, 'GET', '/api/setup/state', CSRF_HEADERS)).json().services.radarr).toBe(true);
  });

  it('un seul serveur par défaut par couple (type, 4K), qui suit ajouts, modifications et suppressions', async () => {
    const { app, body, send } = await setup();
    const add = async (patch: object) => (await send('POST', ARR_SERVERS_PATH, body(patch))).json<ArrServer>();
    const defaults = () =>
      listArrServers(app.data)
        .filter((s) => s.isDefault)
        .map((s) => s.name)
        .sort();

    const first = await add({ name: 'Films' });
    await add({ name: 'Films bis', isDefault: true });
    const uhd = await add({ name: 'Films 4K', is4k: true, qualityProfileId: 7 });
    expect(defaults()).toEqual(['Films 4K', 'Films bis']);

    // Repasser le premier par défaut retire le défaut du second (index unique partiel).
    await send('PUT', `${ARR_SERVERS_PATH}/${first.id}`, body({ name: 'Films', apiKey: '', isDefault: true }));
    expect(defaults()).toEqual(['Films', 'Films 4K']);
    // Le serveur 4K passe en normal : le couple 4K n'a plus de serveur, le normal garde son défaut.
    await send('PUT', `${ARR_SERVERS_PATH}/${uhd.id}`, body({ name: 'Films 4K', apiKey: '', is4k: false }));
    expect(defaults()).toEqual(['Films']);
    // Supprimer le défaut : le plus ancien des restants le devient.
    expect((await send('DELETE', `${ARR_SERVERS_PATH}/${first.id}`)).statusCode).toBe(204);
    expect(defaults()).toEqual(['Films bis']);

    expect((await send('DELETE', `${ARR_SERVERS_PATH}/${first.id}`)).statusCode).toBe(404);
    expect((await send('PUT', `${ARR_SERVERS_PATH}/99`, body())).statusCode).toBe(404);
  });

  it('suppression : le dernier serveur non 4K d’un type est refusé (409), les serveurs 4K se suppriment', async () => {
    const { body, send } = await setup();
    const add = async (patch: object) => (await send('POST', ARR_SERVERS_PATH, body(patch))).json<ArrServer>();
    const only = await add({ name: 'Films' });
    const uhd = await add({ name: 'Films 4K', is4k: true });
    const refused = await send('DELETE', `${ARR_SERVERS_PATH}/${only.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Gardez au moins un serveur Radarr');
    expect((await send('DELETE', `${ARR_SERVERS_PATH}/${uhd.id}`)).statusCode).toBe(204);
    const other = await add({ name: 'Films bis' });
    expect((await send('DELETE', `${ARR_SERVERS_PATH}/${only.id}`)).statusCode).toBe(204);
    expect((await send('DELETE', `${ARR_SERVERS_PATH}/${other.id}`)).statusCode).toBe(409);
  });

  it('modification : clé gardée si laissée vide à la même adresse, exigée pour une nouvelle adresse', async () => {
    const { arr, body, send } = await setup();
    const { id } = (await send('POST', ARR_SERVERS_PATH, body())).json<ArrServer>();
    const kept = await send('PUT', `${ARR_SERVERS_PATH}/${id}`, body({ apiKey: '', rootFolderPath: '/4k' }));
    expect(kept.json()).toMatchObject({ rootFolderPath: '/4k', apiKey: { set: true } });
    expect(arr.requests.at(-1)?.headers['x-api-key']).toBe(KEY);
    const other = await fakeArr();
    const moved = await send('PUT', `${ARR_SERVERS_PATH}/${id}`, body({ url: other.url, apiKey: '' }));
    expect(moved.statusCode).toBe(400);
    expect(other.requests).toHaveLength(0);
  });

  it('champs propres au type : Sonarr garde type de série et profil de langue, pas la disponibilité minimale', async () => {
    const { send, body } = await setup();
    const sonarr = await send(
      'POST',
      ARR_SERVERS_PATH,
      body({ type: 'sonarr', name: 'Séries', minimumAvailability: 'announced', languageProfileId: 2 }),
    );
    expect(sonarr.json()).toMatchObject({ minimumAvailability: null, seriesType: 'standard', languageProfileId: 2 });
  });

  it('options d’envoi : étiquette du membre, recherche, adresse externe normalisée, réglages anime (Sonarr seulement)', async () => {
    const { send, body } = await setup();
    const options = {
      tagRequester: true,
      searchOnAdd: false,
      externalUrl: 'https://radarr.exemple.fr/',
      tags: [3],
      animeQualityProfileId: 7,
      animeRootFolderPath: '/anime',
      animeSeriesType: 'anime',
      animeLanguageProfileId: 2,
      animeTags: [4],
    };
    const radarr = await send('POST', ARR_SERVERS_PATH, body(options));
    expect(radarr.statusCode).toBe(201);
    // Radarr n'a pas de réglages anime (comme chez Seerr) : ils sont vidés ; le reste est gardé.
    expect(radarr.json()).toMatchObject({
      tagRequester: true,
      searchOnAdd: false,
      externalUrl: 'https://radarr.exemple.fr',
      tags: [3],
      animeQualityProfileId: null,
      animeRootFolderPath: null,
      animeSeriesType: null,
      animeLanguageProfileId: null,
      animeTags: [],
    });
    const sonarr = await send('POST', ARR_SERVERS_PATH, body({ ...options, type: 'sonarr', name: 'Séries' }));
    expect(sonarr.json()).toMatchObject({
      animeQualityProfileId: 7,
      animeRootFolderPath: '/anime',
      animeSeriesType: 'anime',
      animeLanguageProfileId: 2,
      animeTags: [4],
    });
    // Les réglages se relisent tels quels, et un `PUT` sans eux revient aux valeurs par défaut.
    const { id } = sonarr.json<ArrServer>();
    const cleared = await send(
      'PUT',
      `${ARR_SERVERS_PATH}/${id}`,
      body({ type: 'sonarr', name: 'Séries', apiKey: '' }),
    );
    expect(cleared.json()).toMatchObject({
      tagRequester: false,
      searchOnAdd: true,
      externalUrl: null,
      animeQualityProfileId: null,
      animeSeriesType: null,
      animeTags: [],
    });
  });

  it('adresse externe invalide : 400, rien n’est enregistré', async () => {
    const { send, body } = await setup();
    expect((await send('POST', ARR_SERVERS_PATH, body({ externalUrl: 'pas une adresse' }))).statusCode).toBe(400);
    expect((await send('GET', ARR_SERVERS_PATH)).json()).toEqual([]);
  });

  it('test en direct : les étiquettes du serveur sont renvoyées quand il les donne', async () => {
    const { routes } = fakeTagRoutes([{ id: 3, label: 'films' }]);
    const arr = await serve({
      'GET /api/v3/system/status': keyed({ version: '5.14.0' }),
      'GET /api/v3/qualityprofile': keyed([{ id: 4, name: 'HD-1080p' }]),
      'GET /api/v3/rootfolder': keyed([{ id: 1, path: '/films', freeSpace: 1 }]),
      'GET /api/v3/tag': routes['GET /api/v3/tag'] as FakeHandler,
    });
    const { send } = await setup();
    const res = await send('POST', ARR_SERVERS_TEST_PATH, { type: 'radarr', url: arr.url, apiKey: KEY });
    expect(res.json()).toMatchObject({ tags: [{ id: 3, label: 'films' }] });
  });
});

describe('reprise des anciens réglages Radarr/Sonarr au démarrage', () => {
  const legacy = (cryptoKey: Buffer, patch: object = {}) =>
    JSON.stringify({
      url: 'http://radarr:7878',
      apiKey: encrypt(cryptoKey, 'cle'),
      qualityProfileId: 9,
      rootFolderPath: '/nouveau',
      ...patch,
    });

  it('réglage plus récent que la copie de la migration : serveur par défaut mis à jour, réglage supprimé', () => {
    const data = openDataDir(tempDir());
    const { db, cryptoKey } = data;
    addArrServer(data, { type: 'radarr', url: 'http://ancien:7878', rootFolderPath: '/ancien' });
    addArrServer(data, { type: 'radarr', url: 'http://autre:7878', is4k: true });
    db.$client.prepare('update arr_servers set updated_at = 1000').run();
    db.$client
      .prepare('insert into settings (key, value, updated_at) values (?, ?, 2000)')
      .run('radarr', legacy(cryptoKey));
    adoptLegacyArrSettings(db);
    const [normal, uhd] = listArrServers(data);
    expect(normal).toMatchObject({
      url: 'http://radarr:7878',
      apiKey: 'cle',
      rootFolderPath: '/nouveau',
      name: 'Radarr',
    });
    expect(uhd).toMatchObject({ url: 'http://autre:7878', is4k: true });
    expect(db.$client.prepare('select count(*) as n from settings').get()).toEqual({ n: 0 });
    db.$client.close();
  });

  it('copie déjà à jour : serveur inchangé ; aucun serveur : créé ; réglage incomplet : laissé', () => {
    const data = openDataDir(tempDir());
    const { db, cryptoKey } = data;
    addArrServer(data, { type: 'radarr', url: 'http://ancien:7878' });
    db.$client.prepare('update arr_servers set updated_at = 3000').run();
    const insert = db.$client.prepare('insert into settings (key, value, updated_at) values (?, ?, 2000)');
    insert.run('radarr', legacy(cryptoKey));
    insert.run('sonarr', legacy(cryptoKey, { url: 'http://sonarr:8989', seriesType: 'anime' }));
    adoptLegacyArrSettings(db);
    expect(listArrServers(data).map((s) => [s.type, s.url, s.isDefault, s.seriesType])).toEqual([
      ['radarr', 'http://ancien:7878', true, null],
      ['sonarr', 'http://sonarr:8989', true, 'anime'],
    ]);
    insert.run('radarr', JSON.stringify({ url: 'http://x' }));
    adoptLegacyArrSettings(db);
    expect(db.$client.prepare('select key from settings').all()).toEqual([{ key: 'radarr' }]);
    db.$client.close();
  });
});
