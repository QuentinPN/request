import { describe, expect, it } from 'vitest';
import type { IntegrationError } from '../src/server/integrations/http.ts';
import { jellyfinServer } from '../src/server/integrations/jellyfin.ts';
import { matchItems } from '../src/server/integrations/media-server.ts';
import { createAvailability, RESCAN_MIN_INTERVAL_MS } from '../src/server/services/availability.ts';
import { createMediaServers } from '../src/server/services/media-server.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { createTmdbProvider } from '../src/server/services/tmdb.ts';
import { jellyfinWebLink } from '../src/shared/emby.ts';
import { watchUrl } from '../src/shared/media-server.ts';
import type { Setting } from '../src/shared/settings.ts';
import { type FakeHandler, type FakeRoutes, status } from './fake-server.ts';
import { trackApps, trackFakeServers } from './helpers.ts';

const serve = trackFakeServers();
const newApp = trackApps();

const API_KEY = 'CLE-JELLYFIN-SECRETE';
const AUTHORIZATION = 'MediaBrowser Client="Request", Device="Server", DeviceId="request", Version="1.0"';

interface Entry {
  id: string;
  type: 'Movie' | 'Series';
  tmdb?: number;
  tvdb?: number;
  parent: string;
  virtual?: boolean;
  added?: string;
}

/** 250 films (plus d'une page de 200) dans « films », une série et un film « Virtual » (sans fichier). */
const ENTRIES: Entry[] = [
  ...Array.from({ length: 250 }, (_, i): Entry => ({ id: `m-${i}`, type: 'Movie', tmdb: 1000 + i, parent: 'films' })),
  { id: 'virtuel', type: 'Movie', tmdb: 9999, parent: 'films', virtual: true },
  { id: 's-1', type: 'Series', tmdb: 1399, tvdb: 121361, parent: 'series', added: '2026-11-10T10:00:00Z' },
  { id: 'm-recent', type: 'Movie', tmdb: 603, parent: 'films', added: '2026-11-15T10:00:00Z' },
];

/** Répond seulement si l'en-tête `Authorization` porte la clé ; sinon 401, comme Jellyfin. */
const authorized =
  (handler: FakeHandler | unknown): FakeHandler =>
  (req, res) => {
    if (req.headers.authorization !== `${AUTHORIZATION}, Token="${API_KEY}"`) return status(401)(req, res);
    return typeof handler === 'function' ? (handler as FakeHandler)(req, res) : status(200, handler)(req, res);
  };

const items: FakeHandler = (req, res) => {
  const q = req.query;
  if (q.IncludeItemTypes === 'Episode') {
    const Items = [
      { ParentIndexNumber: 1 },
      { ParentIndexNumber: 1 },
      { ParentIndexNumber: 2 },
      { ParentIndexNumber: 2, LocationType: 'Virtual' },
      { ParentIndexNumber: 0 },
    ];
    return status(200, { Items })(req, res);
  }
  if (q.SortBy === 'DateCreated') {
    const Items = ENTRIES.filter((e) => e.added)
      .sort((a, b) => (b.added ?? '').localeCompare(a.added ?? ''))
      .map((e) => ({ Id: e.id, Type: e.type, DateCreated: e.added, ProviderIds: { Tmdb: String(e.tmdb) } }));
    return status(200, { Items })(req, res);
  }
  const all = ENTRIES.filter((e) => e.type === q.IncludeItemTypes && (!q.ParentId || e.parent === q.ParentId));
  const start = Number(q.StartIndex ?? 0);
  const Items = all.slice(start, start + Number(q.Limit ?? all.length)).map((e) => ({
    Id: e.id,
    Name: e.id,
    ...(e.virtual && { LocationType: 'Virtual' }),
    ProviderIds: { ...(e.tmdb && { Tmdb: String(e.tmdb) }), ...(e.tvdb && { Tvdb: String(e.tvdb) }) },
  }));
  return status(200, { Items, TotalRecordCount: all.length })(req, res);
};

const authenticate: FakeHandler = (req, res) => {
  const { Username, Pw } = req.body as { Username: string; Pw: string };
  if (req.headers.authorization !== AUTHORIZATION) return status(400)(req, res);
  if (Username === 'alice' && Pw === 'bon')
    return status(200, {
      User: { Id: 'j-1', Name: 'alice', PrimaryImageTag: 'tag', Policy: { IsAdministrator: true } },
      AccessToken: 'JETON-DE-SESSION',
    })(req, res);
  return status(401)(req, res);
};

const jellyfinRoutes: FakeRoutes = {
  'GET /System/Info': authorized({ ServerName: 'Salon Jellyfin', Version: '10.10.7', Id: 'jf-srv' }),
  'GET /System/Info/Public': { Id: 'jf-srv' },
  'POST /Users/AuthenticateByName': authenticate,
  'GET /Users': authorized([
    { Id: 'j-1', Name: 'alice', Policy: { IsAdministrator: true } },
    { Id: 'j-2', Name: 'bob', Policy: { IsDisabled: true } },
  ]),
  'GET /Library/VirtualFolders': authorized([
    { Name: 'Films', ItemId: 'films', CollectionType: 'movies' },
    { Name: 'Séries', ItemId: 'series', CollectionType: 'tvshows' },
    { Name: 'Musique', ItemId: 'musique', CollectionType: 'music' },
  ]),
  'GET /Items': authorized(items),
};

const configOf = (url: string, libraryIds: string[] = []): Setting<'mediaServer'> => ({
  kind: 'jellyfin',
  url,
  apiKey: API_KEY,
  libraryIds,
  publicUrl: null,
});

const fakeJellyfin = async () => {
  const server = await serve(jellyfinRoutes);
  return { ...server, jellyfin: jellyfinServer(configOf(server.url)) };
};

const failure = async (promise: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await promise;
  } catch (error) {
    return error as IntegrationError;
  }
  throw new Error('aurait dû échouer');
};

describe('Jellyfin', () => {
  it('test : nom, version et id, clé dans l’en-tête Authorization MediaBrowser (pas X-Emby-Token)', async () => {
    const { jellyfin, requests } = await fakeJellyfin();
    expect(await jellyfin.test()).toEqual({ serverName: 'Salon Jellyfin', version: '10.10.7', serverId: 'jf-srv' });
    expect(requests[0]?.headers['x-emby-token']).toBeUndefined();
  });

  it('test : clé refusée → unauthorized, sans la divulguer', async () => {
    const server = await serve(jellyfinRoutes);
    const error = await failure(jellyfinServer({ ...configOf(server.url), apiKey: 'mauvaise' }).test());
    expect(error.kind).toBe('unauthorized');
    expect(JSON.stringify({ message: error.message, url: error.url })).not.toContain('mauvaise');
  });

  it('connexion d’un membre : identifiant et mot de passe, sans jeton dans l’en-tête', async () => {
    const { jellyfin } = await fakeJellyfin();
    expect(await jellyfin.authenticate({ method: 'password', username: 'alice', password: 'bon' })).toEqual({
      id: 'j-1',
      name: 'alice',
      isAdmin: true,
      avatarUrl: '/Users/j-1/Images/Primary?tag=tag',
    });
    const refused = await failure(jellyfin.authenticate({ method: 'password', username: 'alice', password: 'non' }));
    expect(refused.kind).toBe('unauthorized');
    expect(refused.message).toBe('Identifiant ou mot de passe Jellyfin incorrect');
    expect((await failure(jellyfin.authenticate({ method: 'plex', token: 't' }))).kind).toBe('unauthorized');
  });

  it('membres et bibliothèques : listes sans /Query', async () => {
    const { jellyfin } = await fakeJellyfin();
    expect(await jellyfin.listUsers()).toEqual([
      { id: 'j-1', name: 'alice', isAdmin: true, isDisabled: false, avatarUrl: null },
      { id: 'j-2', name: 'bob', isAdmin: false, isDisabled: true, avatarUrl: null },
    ]);
    expect(await jellyfin.listLibraries()).toEqual([
      { id: 'films', name: 'Films', type: 'movies' },
      { id: 'series', name: 'Séries', type: 'tvshows' },
      { id: 'musique', name: 'Musique', type: 'other' },
    ]);
  });

  it('balayage : toutes les pages, ids TMDB/TVDB, éléments « Virtual » écartés', async () => {
    const { jellyfin, requests } = await fakeJellyfin();
    if (jellyfin.lookup.mode !== 'scan') throw new Error('Jellyfin balaie ses bibliothèques');
    const movies = await jellyfin.lookup.list({ type: 'movie', libraryIds: ['films'] });
    expect(movies).toHaveLength(251);
    expect(movies.map((m) => m.itemId)).not.toContain('virtuel');
    expect(movies).toContainEqual({ itemId: 'm-recent', name: 'm-recent', tmdbId: 603 });
    const scans = requests.filter((r) => r.path === '/Items');
    expect(scans.map((r) => r.query.StartIndex)).toEqual(['0', '200']);
    expect(scans[0]?.query).toMatchObject({ ParentId: 'films', Fields: 'ProviderIds', IncludeItemTypes: 'Movie' });

    const series = await jellyfin.lookup.list({ type: 'series' });
    expect(matchItems(series, { type: 'series', tvdbIds: [121361] })).toEqual([
      { itemId: 's-1', name: 's-1', tmdbId: 1399, tvdbId: 121361 },
    ]);
  });

  it('épisodes par saison, derniers ajouts et lien « Regarder dans Jellyfin »', async () => {
    const { jellyfin, requests } = await fakeJellyfin();
    expect(await jellyfin.seasonAvailability('s-1')).toEqual([
      { seasonNumber: 0, episodesPresent: 1, isSpecials: true },
      { seasonNumber: 1, episodesPresent: 2, isSpecials: false },
      { seasonNumber: 2, episodesPresent: 1, isSpecials: false },
    ]);
    expect(await jellyfin.latestItems({ limit: 5, userId: 'j-1' })).toEqual([
      { type: 'movie', tmdbId: 603, addedAt: Date.parse('2026-11-15T10:00:00Z') },
      { type: 'tv', tmdbId: 1399, addedAt: Date.parse('2026-11-10T10:00:00Z') },
    ]);
    expect(requests.at(-1)?.query.UserId).toBe('j-1');
    expect(await jellyfin.serverId()).toBe('jf-srv');
    expect(jellyfinWebLink({ publicUrl: 'https://jf.exemple.fr/', serverId: 'jf-srv' }, 'm-1')).toBe(
      'https://jf.exemple.fr/web/index.html#!/details?id=m-1&serverId=jf-srv',
    );
    expect(watchUrl({ kind: 'jellyfin', serverId: 'jf-srv', publicUrl: 'https://jf.exemple.fr' }, 'm-1')).toBe(
      'https://jf.exemple.fr/web/index.html#!/details?id=m-1&serverId=jf-srv',
    );
  });

  it('photo d’un membre : relayée avec la clé dans l’en-tête Authorization', async () => {
    const { jellyfin, url } = await fakeJellyfin();
    expect(jellyfin.avatarRequest('/Users/j-1/Images/Primary?tag=tag')).toEqual({
      url: `${url}/Users/j-1/Images/Primary?tag=tag`,
      headers: { Authorization: `${AUTHORIZATION}, Token="${API_KEY}"` },
    });
  });
});

describe('disponibilité sur Jellyfin', () => {
  it('statut « disponible » d’après le balayage, gardé en cache entre deux lots', async () => {
    const app = await newApp();
    const jellyfin = await serve(jellyfinRoutes);
    const tmdb = await serve({});
    const { db, cryptoKey } = app.data;
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
    setSetting(db, cryptoKey, 'mediaServer', configOf(jellyfin.url, ['films']));
    const availability = createAvailability(app.data, {
      tmdb: createTmdbProvider(app.data, tmdb.url),
      mediaServers: createMediaServers(app.data),
    });
    const first = await availability.statusesFor([
      { type: 'movie', tmdbId: 603 },
      { type: 'movie', tmdbId: 9999 },
    ]);
    expect(first.get('movie:603')).toEqual({ status: 'available', embyItemId: 'm-recent' });
    expect(first.get('movie:9999')?.status).not.toBe('available');
    const scans = () => jellyfin.requests.filter((r) => r.path === '/Items').length;
    const before = scans();
    await availability.statusesFor([{ type: 'movie', tmdbId: 1001 }]);
    expect(scans()).toBe(before);
    // Un webhook Radarr annonce un fichier : le balayage est relu tout de suite, sans attendre sa fin de vie.
    await availability.refresh([{ type: 'movie', tmdbId: 1001 }], { forget: 'radarr' });
    expect(scans()).toBeGreaterThan(before);
  });

  it('rafale de webhooks Sonarr : un balayage des séries au plus par fenêtre, aucun des films', async () => {
    const app = await newApp();
    const jellyfin = await serve(jellyfinRoutes);
    const tmdb = await serve({});
    const { db, cryptoKey } = app.data;
    setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
    setSetting(db, cryptoKey, 'mediaServer', configOf(jellyfin.url));
    const clock = { now: Date.parse('2026-11-18T10:00:00Z') };
    const availability = createAvailability(app.data, {
      tmdb: createTmdbProvider(app.data, tmdb.url),
      mediaServers: createMediaServers(app.data),
      now: () => clock.now,
    });
    const scansOf = (type: string) =>
      jellyfin.requests.filter((r) => r.path === '/Items' && r.query.IncludeItemTypes === type).length;
    const show = { type: 'tv', tmdbId: 1399 } as const;
    await availability.statusesFor([show, { type: 'movie', tmdbId: 603 }]);
    expect(scansOf('Series')).toBe(1);
    const movies = scansOf('Movie');

    // Le premier webhook relit les séries ; les suivants, dans la même fenêtre, ne font que les déclarer périmées.
    for (let i = 0; i < 5; i++) await availability.refresh([show], { forget: 'sonarr' });
    expect(scansOf('Series')).toBe(2);
    expect(scansOf('Movie')).toBe(movies);

    clock.now += RESCAN_MIN_INTERVAL_MS;
    await availability.refresh([show], { forget: 'sonarr' });
    expect(scansOf('Series')).toBe(3);
    expect(scansOf('Movie')).toBe(movies);
  });
});
