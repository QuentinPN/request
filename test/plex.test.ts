import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import type { IntegrationError } from '../src/server/integrations/http.ts';
import { createPlexPin, plexAuthUrl, plexIds, plexServer, xmlElements } from '../src/server/integrations/plex.ts';
import { getMediaServer, setSetting } from '../src/server/services/settings.ts';
import { getUser } from '../src/server/services/users.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import {
  PLEX_PIN_CHECK_PATH,
  PLEX_PIN_PATH,
  type PlexPinCreated,
  plexWebLink,
  WATCH_LINK_PATH,
  watchUrl,
} from '../src/shared/media-server.ts';
import { ofMediaServer, type Setting } from '../src/shared/settings.ts';
import { type FakeHandler, type FakeRequest, status } from './fake-server.ts';
import { loginAs, loginAsOwner, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const apps: FastifyInstance[] = [];
// Après trackTempDirs : les afterEach passent en ordre inverse, les apps ferment avant la suppression des dossiers.
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const serve = trackFakeServers();

const OWNER_TOKEN = 'JETON-PROPRIETAIRE-SECRET';
const FRIEND_TOKEN = 'JETON-AMIE-SECRET';
const STRANGER_TOKEN = 'JETON-INCONNU-SECRET';
const MACHINE = 'machine-1';
const CLIENT_ID = 'client-test';

const xml =
  (body: string): FakeHandler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(body);
  };
const tokenOf = (req: FakeRequest) => req.headers['x-plex-token'];
/** Répond seulement au jeton du propriétaire (401 sinon, comme Plex). */
const ownerOnly =
  (handler: FakeHandler): FakeHandler =>
  (req, res) =>
    tokenOf(req) === OWNER_TOKEN ? handler(req, res) : status(401)(req, res);

const ACCOUNTS: Record<string, { id: number; username: string; title: string; thumb: string }> = {
  [OWNER_TOKEN]: { id: 1, username: 'proprio', title: 'Proprio', thumb: 'https://plex.tv/users/a1/avatar?c=1' },
  [FRIEND_TOKEN]: { id: 2, username: 'amie', title: 'Amie', thumb: 'https://plex.tv/users/a2/avatar?c=1' },
  [STRANGER_TOKEN]: { id: 3, username: 'inconnu', title: '', thumb: '' },
};

const USERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="x" totalSize="3">
  <User id="2" title="Amie" username="amie" thumb="https://plex.tv/users/a2/avatar?c=1&amp;s=2">
    <Server id="9" serverId="9" machineIdentifier="${MACHINE}" name="Salon" home="0" allLibraries="1" owned="1" pending="0"/>
  </User>
  <User id="4" title="Ailleurs" username="ailleurs" thumb="">
    <Server id="10" machineIdentifier="autre-serveur" name="Autre"/>
  </User>
  <User id="5" title="Sans serveur" username="vide"/>
</MediaContainer>`;

const resourcesXml = (owned: '0' | '1') => `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="2">
  <Device name="Téléphone" product="Plex for Android" clientIdentifier="telephone" provides="player" owned="1"/>
  <Device name="Salon" product="Plex Media Server" clientIdentifier="${MACHINE}" provides="server" owned="${owned}">
    <Connection protocol="https" address="10.0.0.2" port="32400" uri="https://10-0-0-2.abc.plex.direct:32400" local="1"/>
  </Device>
</MediaContainer>`;

/** Faux plex.tv : comptes par jeton, amis du propriétaire, appareils, codes PIN (état réglable). */
async function fakePlexTv({ owned = '1' as '0' | '1', pinExpiresAt = new Date(Date.now() + 30 * 60_000) } = {}) {
  /** `slow` : plex.tv tarde à répondre (échanges simultanés). */
  const pin = { authToken: null as string | null, gone: false, slow: false };
  const server = await serve({
    'GET /users/account.json': (req, res) => {
      const user = ACCOUNTS[String(tokenOf(req))];
      return user ? status(200, { user })(req, res) : status(401)(req, res);
    },
    'GET /api/users': ownerOnly(xml(USERS_XML)),
    'GET /api/resources': ownerOnly(xml(resourcesXml(owned))),
    'POST /api/v2/pins': { id: 77, code: 'CODE-PIN', expiresAt: pinExpiresAt.toISOString(), authToken: null },
    'GET /api/v2/pins/77': async (req, res) => {
      if (pin.slow) await new Promise((resolve) => setTimeout(resolve, 100));
      if (pin.gone) return status(404)(req, res);
      if (req.query.code !== 'CODE-PIN') return status(404)(req, res);
      return status(200, { id: 77, code: 'CODE-PIN', authToken: pin.authToken })(req, res);
    },
  });
  return { ...server, pin };
}

interface Movie {
  ratingKey: string;
  type: 'movie' | 'show';
  guid?: string;
  Guid?: Array<{ id: string }>;
  addedAt?: number;
}

/** 230 films (plus d'une page de 200) dans la section 1, une série dans la 2. */
const SECTION_1: Movie[] = [
  ...Array.from(
    { length: 230 },
    (_, i): Movie => ({ ratingKey: `${i}`, type: 'movie', Guid: [{ id: `tmdb://${5000 + i}` }] }),
  ),
  // Ancien agent, sans `Guid`.
  { ratingKey: 'ancien', type: 'movie', guid: 'com.plexapp.agents.themoviedb://603?lang=fr', addedAt: 1_794_700_000 },
  {
    ratingKey: 'neuf',
    type: 'movie',
    Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://604' }],
    addedAt: 1_794_800_000,
  },
];
const SECTION_2: Movie[] = [
  {
    ratingKey: 'serie',
    type: 'show',
    Guid: [{ id: 'tvdb://121361' }, { id: 'tmdb://1399' }],
    addedAt: 1_794_750_000,
  },
];

const section =
  (items: Movie[]): FakeHandler =>
  (req, res) => {
    if (req.query.includeGuids !== '1') return status(400)(req, res);
    const sorted =
      req.query.sort === 'addedAt:desc' ? [...items].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)) : items;
    const start = Number(req.headers['x-plex-container-start'] ?? 0);
    const size = Number(req.headers['x-plex-container-size'] ?? sorted.length);
    const Metadata = sorted.slice(start, start + size).map((m) => ({ title: `Titre ${m.ratingKey}`, ...m }));
    return status(200, { MediaContainer: { size: Metadata.length, totalSize: items.length, Metadata } })(req, res);
  };

/** Faux Plex Media Server (jeton du propriétaire). */
const fakePms = () =>
  serve({
    'GET /': ownerOnly(
      status(200, { MediaContainer: { friendlyName: 'Salon', version: '1.41.3', machineIdentifier: MACHINE } }),
    ),
    'GET /library/sections': ownerOnly(
      status(200, {
        MediaContainer: {
          Directory: [
            { key: '1', title: 'Films', type: 'movie', agent: 'tv.plex.agents.movie' },
            { key: '2', title: 'Séries', type: 'show', agent: 'tv.plex.agents.series' },
            { key: '3', title: 'Vidéos perso', type: 'movie', agent: 'com.plexapp.agents.none' },
            { key: '4', title: 'Musique', type: 'artist', agent: 'tv.plex.agents.music' },
          ],
        },
      }),
    ),
    'GET /library/sections/1/all': ownerOnly(section(SECTION_1)),
    'GET /library/sections/2/all': ownerOnly(section(SECTION_2)),
    'GET /library/metadata/serie/children': ownerOnly(
      status(200, {
        MediaContainer: {
          Metadata: [
            { ratingKey: 's0', index: 0, leafCount: 2 },
            { ratingKey: 's1', index: 1, leafCount: 10 },
            { ratingKey: 's2', index: 2, leafCount: 0 },
          ],
        },
      }),
    ),
  });

const configOf = (url: string, apiKey = OWNER_TOKEN): Setting<'mediaServer'> => ({
  kind: 'plex',
  url,
  apiKey,
  libraryIds: [],
  publicUrl: null,
});

async function plexPair(plexTvOptions?: Parameters<typeof fakePlexTv>[0]) {
  const plexTv = await fakePlexTv(plexTvOptions);
  const pms = await fakePms();
  const options = { plexTvUrl: plexTv.url, clientId: CLIENT_ID };
  return { plexTv, pms, options, plex: plexServer(configOf(pms.url), options) };
}

const failure = async (promise: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await promise;
  } catch (error) {
    return error as IntegrationError;
  }
  throw new Error('aurait dû échouer');
};

// --- Intégration ---

describe('Plex : serveur', () => {
  it('test : nom, version, machineIdentifier ; jeton et identifiant d’appareil en en-têtes', async () => {
    const { plex, pms, plexTv } = await plexPair();
    expect(await plex.test()).toEqual({ serverName: 'Salon', version: '1.41.3', serverId: MACHINE });
    expect(pms.requests[0]?.headers).toMatchObject({
      'x-plex-token': OWNER_TOKEN,
      'x-plex-client-identifier': CLIENT_ID,
      'x-plex-product': 'Request',
    });
    expect(plexTv.requests.map((r) => r.path)).toEqual(['/api/resources']);
  });

  it('test : refuse un jeton qui n’est pas celui du propriétaire du serveur', async () => {
    const { plex } = await plexPair({ owned: '0' });
    const error = await failure(plex.test());
    expect(error.kind).toBe('unauthorized');
    expect(error.message).toBe('Ce jeton n’est pas celui du propriétaire de ce serveur Plex');
  });

  it('test : jeton refusé par le serveur → unauthorized, sans le divulguer', async () => {
    const { pms, options } = await plexPair();
    const error = await failure(plexServer(configOf(pms.url, 'MAUVAIS-JETON'), options).test());
    expect(error.kind).toBe('unauthorized');
    expect(JSON.stringify({ message: error.message, url: error.url })).not.toContain('MAUVAIS-JETON');
  });

  it('bibliothèques : films et séries, sans les sections sans agent', async () => {
    const { plex } = await plexPair();
    expect(await plex.listLibraries()).toEqual([
      { id: '1', name: 'Films', type: 'movies' },
      { id: '2', name: 'Séries', type: 'tvshows' },
      { id: '4', name: 'Musique', type: 'other' },
    ]);
  });

  it('balayage : GUID tmdb:// et tvdb:// (nouvel et ancien agent), page après page', async () => {
    const { plex, pms } = await plexPair();
    if (plex.lookup.mode !== 'scan') throw new Error('Plex balaie ses bibliothèques');
    const movies = await plex.lookup.list({ type: 'movie' });
    expect(movies).toHaveLength(232);
    expect(movies).toContainEqual({ itemId: 'ancien', name: 'Titre ancien', tmdbId: 603 });
    expect(movies).toContainEqual({ itemId: 'neuf', name: 'Titre neuf', tmdbId: 604 });
    const pages = pms.requests.filter((r) => r.path === '/library/sections/1/all');
    expect(pages.map((r) => r.headers['x-plex-container-start'])).toEqual(['0', '200']);
    // Section sans agent jamais balayée.
    expect(pms.requests.some((r) => r.path === '/library/sections/3/all')).toBe(false);

    expect(await plex.lookup.list({ type: 'series', libraryIds: ['2'] })).toEqual([
      { itemId: 'serie', name: 'Titre serie', tmdbId: 1399, tvdbId: 121361 },
    ]);
  });

  it('épisodes par saison (leafCount), derniers ajouts, id du serveur', async () => {
    const { plex } = await plexPair();
    expect(await plex.seasonAvailability('serie')).toEqual([
      { seasonNumber: 0, episodesPresent: 2, isSpecials: true },
      { seasonNumber: 1, episodesPresent: 10, isSpecials: false },
    ]);
    expect(await plex.latestItems({ limit: 3, userId: 'ignoré' })).toEqual([
      { type: 'movie', tmdbId: 604, addedAt: 1_794_800_000_000 },
      { type: 'tv', tmdbId: 1399, addedAt: 1_794_750_000_000 },
      { type: 'movie', tmdbId: 603, addedAt: 1_794_700_000_000 },
    ]);
    expect(await plex.serverId()).toBe(MACHINE);
  });

  it('membres : le propriétaire, puis les amis qui ont accès à ce serveur', async () => {
    const { plex } = await plexPair();
    expect(await plex.listUsers()).toEqual([
      { id: '1', name: 'Proprio', isAdmin: true, isDisabled: false, avatarUrl: 'https://plex.tv/users/a1/avatar?c=1' },
      {
        id: '2',
        name: 'Amie',
        isAdmin: false,
        isDisabled: false,
        avatarUrl: 'https://plex.tv/users/a2/avatar?c=1&s=2',
      },
    ]);
  });

  it('connexion : propriétaire (admin), amie (membre), compte sans accès refusé (403)', async () => {
    const { plex } = await plexPair();
    expect(await plex.authenticate({ method: 'plex', token: OWNER_TOKEN })).toMatchObject({ id: '1', isAdmin: true });
    expect(await plex.authenticate({ method: 'plex', token: FRIEND_TOKEN })).toMatchObject({ id: '2', isAdmin: false });
    const stranger = await failure(plex.authenticate({ method: 'plex', token: STRANGER_TOKEN }));
    expect(stranger).toMatchObject({ kind: 'unauthorized', status: 403 });
    expect(stranger.message).toBe('Ce compte Plex n’a pas accès à ce serveur');
    expect((await failure(plex.authenticate({ method: 'password', username: 'a', password: 'b' }))).kind).toBe(
      'unauthorized',
    );
  });

  it('photos : seulement sur plex.tv en HTTPS, sans aucun jeton', async () => {
    const { plex } = await plexPair();
    expect(plex.avatarRequest('https://plex.tv/users/a1/avatar?c=1')).toEqual({
      url: 'https://plex.tv/users/a1/avatar?c=1',
      headers: {},
    });
    expect(plex.avatarRequest('https://assets.plex.tv/a.png')).not.toBeNull();
    for (const bad of ['http://plex.tv/a', 'https://evilplex.tv/a', 'https://plex.tv.evil.fr/a', '/Users/1', ''])
      expect(plex.avatarRequest(bad), bad).toBeNull();
  });

  it('lien « Regarder dans Plex » : app.plex.tv, sans adresse publique', () => {
    const expected = `https://app.plex.tv/desktop#!/server/${MACHINE}/details?key=%2Flibrary%2Fmetadata%2F42`;
    expect(plexWebLink(MACHINE, '42')).toBe(expected);
    expect(watchUrl({ kind: 'plex', serverId: MACHINE, publicUrl: null }, '42')).toBe(expected);
  });
});

describe('Plex : lecture', () => {
  it('xmlElements : attributs décodés, éléments imbriqués lus à part', () => {
    const [user] = xmlElements(USERS_XML, 'User');
    expect(user?.attrs).toMatchObject({ id: '2', thumb: 'https://plex.tv/users/a2/avatar?c=1&s=2' });
    expect(xmlElements(user?.inner ?? '', 'Server')[0]?.attrs.machineIdentifier).toBe(MACHINE);
    expect(xmlElements(USERS_XML, 'User')).toHaveLength(3);
    expect(xmlElements('<A t="&lt;&#233;&#x41;&gt;"/>', 'A')[0]?.attrs.t).toBe('<éA>');
  });

  it('plexIds : nouvel agent, ancien agent, ids inconnus ignorés', () => {
    expect(plexIds({ Guid: [{ id: 'tmdb://1' }, { id: 'tvdb://2' }] })).toEqual({ tmdbId: 1, tvdbId: 2 });
    expect(plexIds({ guid: 'com.plexapp.agents.thetvdb://81189/1/1?lang=en' })).toEqual({ tvdbId: 81189 });
    expect(plexIds({ guid: 'plex://movie/5d776', Guid: [{ id: 'imdb://tt1' }] })).toEqual({});
  });

  it('code PIN : créé « fort », fenêtre app.plex.tv ; expiration par défaut si plex.tv n’en donne pas', async () => {
    const plexTv = await serve({ 'POST /api/v2/pins': { id: 5, code: 'C' } });
    const now = Date.parse('2026-11-17T10:00:00Z');
    expect(await createPlexPin({ plexTvUrl: plexTv.url, clientId: CLIENT_ID }, now)).toEqual({
      id: 5,
      code: 'C',
      expiresAt: now + 15 * 60_000,
    });
    expect(plexTv.requests[0]?.query.strong).toBe('true');
    const url = new URL(plexAuthUrl(CLIENT_ID, 'C'));
    expect(url.origin).toBe('https://app.plex.tv');
    expect(new URLSearchParams(url.hash.replace(/^#!\?/, '')).get('clientID')).toBe(CLIENT_ID);
  });
});

// --- Routes ---

async function plexApp(plexTvOptions?: Parameters<typeof fakePlexTv>[0]) {
  const plexTv = await fakePlexTv(plexTvOptions);
  const pms = await fakePms();
  const app = await buildApp({ data: openDataDir(tempDir()), upstreams: { plexTvUrl: plexTv.url } });
  apps.push(app);
  setSetting(app.data.db, app.data.cryptoKey, 'mediaServer', configOf(pms.url));
  return { app, plexTv, pms };
}

const post = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...CSRF_HEADERS, ...headers } });

/** Crée un code PIN : réponse, et cookie signé du navigateur qui l'a demandé (`nom=valeur`). */
async function startPin(app: FastifyInstance) {
  const res = await post(app, PLEX_PIN_PATH);
  expect(res.statusCode).toBe(200);
  const set = res.cookies.find((c) => c.name === 'request_plex_pin');
  expect(set).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: PLEX_PIN_PATH });
  return { ...(res.json() as PlexPinCreated), cookie: `request_plex_pin=${set?.value}` };
}

/** Échange du code désigné par ce cookie. */
const check = (app: FastifyInstance, cookie?: string) => post(app, PLEX_PIN_CHECK_PATH, cookie ? { cookie } : {});

/** Toutes les lignes de toutes les tables, pour vérifier qu'un jeton n'y a jamais été écrit. */
const everyRow = (app: FastifyInstance) => {
  const sqlite = app.data.db.$client;
  const tables = sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => sqlite.prepare(`select * from "${name}"`).all()));
};

describe('connexion Plex par code PIN', () => {
  it('en attente, puis accordé : le propriétaire du serveur devient propriétaire, session ouverte, jeton oublié', async () => {
    const { app, plexTv } = await plexApp();
    const { cookie, authUrl } = await startPin(app);
    expect(authUrl).toContain('code=CODE-PIN');
    expect(cookie).not.toContain('CODE-PIN'); // pas l'id « 77 » : une valeur aléatoire peut le contenir

    const pending = await check(app, cookie);
    expect(pending.json()).toEqual({ status: 'pending' });
    expect(pending.cookies.find((c) => c.name === 'request_session')).toBeUndefined();

    plexTv.pin.authToken = OWNER_TOKEN;
    const granted = await check(app, cookie);
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ status: 'authorized', viewer: { id: '1', name: 'Proprio', role: 'owner' } });
    expect(granted.cookies.find((c) => c.name === 'request_session')).toBeDefined();
    expect(getUser(app.data.db, '1')?.avatar).toBe('https://plex.tv/users/a1/avatar?c=1');
    // Le jeton du membre n'est jamais écrit (celui du propriétaire, chiffré dans les réglages, non plus en clair).
    expect(everyRow(app)).not.toContain(OWNER_TOKEN);

    // Code consommé : un second échange ne rouvre rien.
    expect((await check(app, cookie)).statusCode).toBe(404);
  });

  it('une amie qui a accès au serveur devient membre ; son jeton n’est pas gardé', async () => {
    const { app, plexTv } = await plexApp();
    await loginAsOwner(app);
    const { cookie } = await startPin(app);
    plexTv.pin.authToken = FRIEND_TOKEN;
    const res = await check(app, cookie);
    expect(res.json()).toMatchObject({ status: 'authorized', viewer: { id: '2', name: 'Amie', role: 'member' } });
    expect(everyRow(app)).not.toContain(FRIEND_TOKEN);
  });

  it('compte Plex sans accès au serveur : 403, aucun compte créé', async () => {
    const { app, plexTv } = await plexApp();
    const { cookie } = await startPin(app);
    plexTv.pin.authToken = STRANGER_TOKEN;
    const res = await check(app, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Ce compte Plex n’a pas accès à ce serveur' });
    expect(res.cookies.find((c) => c.name === 'request_session')).toBeUndefined();
    expect(getUser(app.data.db, '3')).toBeNull();
    expect(everyRow(app)).not.toContain(STRANGER_TOKEN);
  });

  it('code expiré : 410, de notre côté comme du côté de plex.tv', async () => {
    const past = await plexApp({ pinExpiresAt: new Date(Date.now() - 1000) });
    const { cookie } = await startPin(past.app);
    expect((await check(past.app, cookie)).statusCode).toBe(410);
    expect((await check(past.app, cookie)).statusCode).toBe(404);

    const { app, plexTv } = await plexApp();
    const created = await startPin(app);
    plexTv.pin.gone = true;
    const res = await check(app, created.cookie);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'Code de connexion Plex expiré, recommencez' });
  });

  it('lié au navigateur : sans cookie, ou avec un cookie falsifié, l’échange est refusé (403)', async () => {
    const { app, plexTv } = await plexApp();
    const { cookie } = await startPin(app);
    plexTv.pin.authToken = OWNER_TOKEN;
    const without = await check(app);
    expect(without.statusCode).toBe(403);
    expect(without.json()).toEqual({ error: 'Connexion Plex non commencée dans ce navigateur' });
    const forged = await check(app, cookie.replace(/\.[^.]+$/, '.signature-fausse'));
    expect(forged.statusCode).toBe(403);
    expect(forged.cookies.find((c) => c.name === 'request_session')).toBeUndefined();
    // Le vrai navigateur, lui, se connecte toujours.
    expect((await check(app, cookie)).json()).toMatchObject({ status: 'authorized' });
  });

  it('deux échanges simultanés du même code : un seul ouvre une session', async () => {
    const { app, plexTv } = await plexApp();
    const { cookie } = await startPin(app);
    plexTv.pin.authToken = OWNER_TOKEN;
    plexTv.pin.slow = true;
    const results = await Promise.all([check(app, cookie), check(app, cookie)]);
    const statuses = results.map((r) =>
      r.statusCode === 200 ? (r.json() as { status: string }).status : r.statusCode,
    );
    expect(statuses.filter((s) => s === 'authorized')).toHaveLength(1);
    expect(results.flatMap((r) => r.cookies).filter((c) => c.name === 'request_session')).toHaveLength(1);
    expect(plexTv.requests.filter((r) => r.path === '/api/v2/pins/77')).toHaveLength(1);
  });

  it('routes publiques (sans session) mais protégées par l’en-tête CSRF ; cookie d’une autre installation refusé', async () => {
    const { app } = await plexApp();
    const { cookie } = await startPin(app);
    const other = await plexApp();
    expect((await check(other.app, cookie)).statusCode).toBe(403);
    const noCsrf = await app.inject({ method: 'POST', url: PLEX_PIN_PATH });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('mauvaise méthode : mot de passe refusé pour Plex, code PIN refusé pour Emby (400)', async () => {
    const { app } = await plexApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF_HEADERS,
      payload: { username: 'a', password: 'b' },
    });
    expect(login.statusCode).toBe(400);
    expect(login.json().error).toBe('Plex se connecte avec le bouton « Se connecter avec Plex »');

    const { db, cryptoKey } = app.data;
    setSetting(db, cryptoKey, 'mediaServer', { ...configOf('http://emby.local'), kind: 'emby' });
    const pin = await post(app, PLEX_PIN_PATH);
    expect(pin.statusCode).toBe(400);
    expect(pin.json().error).toBe('Emby se connecte avec un identifiant et un mot de passe');
  });
});

describe('Plex : membres, réglages et lien', () => {
  it('import : le propriétaire et les amis ayant accès ; photo relayée depuis plex.tv seulement', async () => {
    const { app } = await plexApp();
    const owner = await loginAsOwner(app);
    const res = await post(app, '/api/users/import', owner.headers);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['1', '2']));
    expect(ids).not.toContain('4');
  });

  it('assistant : test du jeton du propriétaire, bibliothèques, enregistrement sans adresse publique', async () => {
    const plexTv = await fakePlexTv();
    const pms = await fakePms();
    const app = await buildApp({ data: openDataDir(tempDir()), upstreams: { plexTvUrl: plexTv.url } });
    apps.push(app);
    const body = { kind: 'plex', url: pms.url, apiKey: OWNER_TOKEN };
    const test = await app.inject({
      method: 'POST',
      url: '/api/setup/mediaServer/test',
      headers: CSRF_HEADERS,
      payload: body,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ serverName: 'Salon', serverId: MACHINE });
    expect(test.json().libraries).toContainEqual({ id: '1', name: 'Films', type: 'movies' });

    const save = await app.inject({
      method: 'PUT',
      url: '/api/settings/mediaServer',
      headers: CSRF_HEADERS,
      payload: { ...body, libraryIds: ['1', '2'] },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      kind: 'plex',
      url: pms.url,
      apiKey: { set: true },
      libraryIds: ['1', '2'],
      publicUrl: null,
    });
    expect(JSON.stringify(save.json())).not.toContain(OWNER_TOKEN);
    const state = await app.inject({ method: 'GET', url: '/api/setup/state' });
    expect(state.json()).toMatchObject({ mediaServerKind: 'plex', services: { mediaServer: true } });
  });

  it('assistant : un jeton qui n’est pas celui du propriétaire est refusé (422)', async () => {
    const plexTv = await fakePlexTv({ owned: '0' });
    const pms = await fakePms();
    const app = await buildApp({ data: openDataDir(tempDir()), upstreams: { plexTvUrl: plexTv.url } });
    apps.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/mediaServer/test',
      headers: CSRF_HEADERS,
      payload: { kind: 'plex', url: pms.url, apiKey: OWNER_TOKEN },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Ce jeton n’est pas celui du propriétaire de ce serveur Plex');
  });

  it('lien « Regarder dans Plex » : id du serveur sans adresse publique', async () => {
    const { app } = await plexApp();
    const member = await loginAs(app, 'member');
    const res = await app.inject({ method: 'GET', url: WATCH_LINK_PATH, headers: member.headers });
    expect(res.json()).toEqual({ link: { kind: 'plex', serverId: MACHINE, publicUrl: null } });
  });
});

describe('changement de type de serveur multimédia', () => {
  it('nom du serveur précédé de « de », élidé devant une voyelle', () => {
    expect(['emby', 'jellyfin', 'plex'].map((k) => ofMediaServer(k as Setting<'mediaServer'>['kind']))).toEqual([
      'd’Emby',
      'de Jellyfin',
      'de Plex',
    ]);
  });
  const put = (app: FastifyInstance, payload: object, headers: Record<string, string>) =>
    app.inject({ method: 'PUT', url: '/api/settings/mediaServer', headers, payload });

  it('refusé (409) dès que des membres existent, avec un message clair', async () => {
    const { app, pms } = await plexApp();
    const owner = await loginAsOwner(app);
    const res = await put(app, { kind: 'jellyfin', url: pms.url, apiKey: 'k' }, owner.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'Impossible de passer de Plex à Jellyfin : des membres existent déjà et leurs comptes (avec leurs demandes) sont liés à Plex.',
    );
    expect(getMediaServer(app.data.db, app.data.cryptoKey)?.kind).toBe('plex');
  });

  it('possible tant qu’aucun membre n’existe ; le jeton d’un autre type n’est jamais repris', async () => {
    const plexTv = await fakePlexTv();
    const pms = await fakePms();
    const jellyfin = await serve({
      'GET /System/Info': { ServerName: 'JF', Version: '10.10.7', Id: 'jf' },
      'GET /Library/VirtualFolders': [],
    });
    const app = await buildApp({ data: openDataDir(tempDir()), upstreams: { plexTvUrl: plexTv.url } });
    apps.push(app);
    expect((await put(app, { kind: 'plex', url: pms.url, apiKey: OWNER_TOKEN }, CSRF_HEADERS)).statusCode).toBe(200);
    // Clé laissée vide : celle de Plex ne vaut pas pour Jellyfin, même à la même adresse.
    const reused = await put(app, { kind: 'jellyfin', url: pms.url, apiKey: '' }, CSRF_HEADERS);
    expect(reused.statusCode).toBe(400);
    const changed = await put(app, { kind: 'jellyfin', url: jellyfin.url, apiKey: 'cle-jf' }, CSRF_HEADERS);
    expect(changed.statusCode).toBe(200);
    expect(getMediaServer(app.data.db, app.data.cryptoKey)).toMatchObject({ kind: 'jellyfin', apiKey: 'cle-jf' });
  });
});

describe('Découvrir avec Plex', () => {
  it('rangée « Ajoutés récemment dans Plex »', async () => {
    const tmdb = await serve({});
    const plexTv = await fakePlexTv();
    const pms = await fakePms();
    const app = await buildApp({
      data: openDataDir(tempDir()),
      upstreams: { plexTvUrl: plexTv.url, tmdbUrl: tmdb.url },
    });
    apps.push(app);
    const { db, cryptoKey } = app.data;
    setSetting(db, cryptoKey, 'mediaServer', configOf(pms.url));
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
    const { headers } = await loginAsOwner(app);
    const res = await app.inject({ method: 'GET', url: '/api/discover', headers });
    const rows = res.json().rows as Array<{ id: string; title: string }>;
    expect(rows.find((r) => r.id === 'emby-recent')?.title).toBe('Ajoutés récemment dans Plex');
  });
});
