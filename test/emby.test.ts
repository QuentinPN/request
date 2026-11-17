import { afterEach, describe, expect, it } from 'vitest';
import {
  authenticateEmbyUser,
  embyWebLink,
  findEmbyItems,
  getEmbySeasonAvailability,
  listEmbyLibraries,
  listEmbyUsers,
  testEmby,
} from '../src/server/integrations/emby.ts';
import type { IntegrationError } from '../src/server/integrations/http.ts';
import { closedPortUrl, startFakeServer, status } from './fake-server.ts';
import authenticateFixture from './fixtures/emby/authenticate.json';
import episodesFixture from './fixtures/emby/episodes.json';
import librariesFixture from './fixtures/emby/libraries.json';
import systemInfoFixture from './fixtures/emby/system-info.json';
import usersFixture from './fixtures/emby/users.json';

const API_KEY = 'SECRET-EMBY-KEY';
const PASSWORD = 'SECRET-PASSWORD';

const closers: Array<() => Promise<void>> = [];
const serve = async (routes: Parameters<typeof startFakeServer>[0]) => {
  const server = await startFakeServer(routes);
  closers.push(server.close);
  return { ...server, config: { url: server.url, apiKey: API_KEY } };
};
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const failure = async (promise: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await promise;
  } catch (error) {
    return error as IntegrationError;
  }
  throw new Error('aurait dû échouer');
};
const expectNoSecret = (error: IntegrationError) => {
  const everything = JSON.stringify({ message: error.message, url: error.url, name: error.name });
  expect(everything).not.toContain(API_KEY);
  expect(everything).not.toContain(PASSWORD);
};

describe('testEmby', () => {
  it('renvoie nom, version et identifiant du serveur, avec la clé en en-tête', async () => {
    const server = await serve({ 'GET /System/Info': systemInfoFixture });
    expect(await testEmby(server.config)).toEqual({
      serverName: 'Salon',
      version: '4.8.10.0',
      serverId: 'abc123serverid',
    });
    expect(server.requests[0]?.headers['x-emby-token']).toBe(API_KEY);
  });

  it("refuse une clé d'API invalide (401) sans la divulguer", async () => {
    const server = await serve({ 'GET /System/Info': status(401) });
    const error = await failure(testEmby(server.config));
    expect(error).toMatchObject({ kind: 'unauthorized', message: "Clé d'API refusée par Emby" });
    expectNoSecret(error);
  });

  it('signale un Emby injoignable', async () => {
    const error = await failure(testEmby({ url: await closedPortUrl(), apiKey: API_KEY }));
    expect(error).toMatchObject({ kind: 'unreachable', message: 'Emby injoignable à cette adresse' });
    expectNoSecret(error);
  });

  it('signale une réponse qui ne ressemble pas à Emby', async () => {
    const server = await serve({ 'GET /System/Info': { hello: 'world' } });
    expect(await failure(testEmby(server.config))).toMatchObject({ kind: 'bad_response' });
  });
});

describe('authenticateEmbyUser', () => {
  it("authentifie un membre, sans jeton d'accès ni mot de passe dans le résultat", async () => {
    const server = await serve({ 'POST /Users/AuthenticateByName': authenticateFixture });
    const user = await authenticateEmbyUser(server.config, 'alice', PASSWORD);
    expect(user).toEqual({ id: 'u-1', name: 'alice', isAdmin: true, avatarUrl: '/Users/u-1/Images/Primary?tag=tag42' });
    expect(JSON.stringify(user)).not.toContain('TOKEN-TO-NEVER-LEAK');
    expect(JSON.stringify(user)).not.toContain(PASSWORD);

    const request = server.requests[0];
    expect(request?.body).toEqual({ Username: 'alice', Pw: PASSWORD });
    expect(request?.headers['x-emby-authorization']).toContain('Client="Request"');
    expect(request?.headers['x-emby-token']).toBeUndefined();
  });

  it('accepte un membre sans photo ni stratégie', async () => {
    const server = await serve({ 'POST /Users/AuthenticateByName': { User: { Id: 7, Name: 'dave' } } });
    expect(await authenticateEmbyUser(server.config, 'dave', 'x')).toEqual({
      id: '7',
      name: 'dave',
      isAdmin: false,
      avatarUrl: null,
    });
  });

  it('refuse de mauvais identifiants avec un message lisible, sans mot de passe', async () => {
    const server = await serve({ 'POST /Users/AuthenticateByName': status(401) });
    const error = await failure(authenticateEmbyUser(server.config, 'alice', PASSWORD));
    expect(error).toMatchObject({ kind: 'unauthorized', message: 'Identifiant ou mot de passe Emby incorrect' });
    expectNoSecret(error);
  });

  it('distingue un compte désactivé ou non autorisé (403) de mauvais identifiants', async () => {
    const server = await serve({ 'POST /Users/AuthenticateByName': status(403) });
    const error = await failure(authenticateEmbyUser(server.config, 'alice', PASSWORD));
    expect(error).toMatchObject({ kind: 'unauthorized', message: 'Compte Emby désactivé ou non autorisé' });
    expectNoSecret(error);
  });

  it('ne retente pas une authentification', async () => {
    const server = await serve({ 'POST /Users/AuthenticateByName': status(500) });
    await failure(authenticateEmbyUser(server.config, 'alice', PASSWORD));
    expect(server.requests).toHaveLength(1);
  });
});

describe('listEmbyUsers', () => {
  it('liste les utilisateurs avec droits, état et photo', async () => {
    const server = await serve({ 'GET /Users': usersFixture });
    expect(await listEmbyUsers(server.config)).toEqual([
      { id: 'u-1', name: 'alice', isAdmin: true, isDisabled: false, avatarUrl: '/Users/u-1/Images/Primary?tag=tag42' },
      { id: 'u-2', name: 'bob', isAdmin: false, isDisabled: true, avatarUrl: null },
      { id: 'u-3', name: 'carol', isAdmin: false, isDisabled: false, avatarUrl: null },
    ]);
  });
});

describe('listEmbyLibraries', () => {
  it('classe les bibliothèques en films, séries ou autre', async () => {
    const server = await serve({ 'GET /Library/VirtualFolders': librariesFixture });
    expect(await listEmbyLibraries(server.config)).toEqual([
      { id: '10', name: 'Films', type: 'movies' },
      { id: '11', name: 'Séries', type: 'tvshows' },
      { id: '12', name: 'Musique', type: 'other' },
      { id: '13', name: 'Mélangé', type: 'other' },
    ]);
  });
});

describe('findEmbyItems', () => {
  it('interroge par ids TMDB et rapproche les résultats sans tenir compte de la casse du fournisseur', async () => {
    const server = await serve({
      'GET /Items': {
        Items: [
          { Id: '100', Name: 'Matrix', ProviderIds: { Tmdb: '603', Imdb: 'tt0133093' } },
          { Id: '101', Name: 'Heat', ProviderIds: { tmdb: '949' } },
          { Id: '102', Name: 'Intrus', ProviderIds: { Tmdb: '1' } },
          { Id: '103', Name: 'Sans ids' },
        ],
      },
    });
    const items = await findEmbyItems(server.config, { type: 'movie', tmdbIds: [603, 949] });
    expect(items).toEqual([
      { embyId: '100', name: 'Matrix', tmdbId: 603 },
      { embyId: '101', name: 'Heat', tmdbId: 949 },
    ]);
    expect(server.requests[0]?.query).toMatchObject({
      Recursive: 'true',
      IncludeItemTypes: 'Movie',
      Fields: 'ProviderIds',
      AnyProviderIdEquals: 'tmdb.603,tmdb.949',
    });
  });

  it('cherche des séries par ids TVDB et TMDB à la fois, sans doublon', async () => {
    const server = await serve({
      'GET /Items': { Items: [{ Id: '200', Name: 'Dark', ProviderIds: { Tmdb: '70523', TVDB: '334824' } }] },
    });
    const items = await findEmbyItems(server.config, { type: 'series', tmdbIds: [70523], tvdbIds: [334824] });
    expect(items).toEqual([{ embyId: '200', name: 'Dark', tmdbId: 70523, tvdbId: 334824 }]);
    expect(server.requests.map((r) => r.query.AnyProviderIdEquals)).toEqual(['tmdb.70523', 'tvdb.334824']);
    expect(server.requests[0]?.query).toMatchObject({ IncludeItemTypes: 'Series', Recursive: 'true' });
  });

  it('découpe les ids en lots de 50', async () => {
    const server = await serve({ 'GET /Items': { Items: [] } });
    const tmdbIds = Array.from({ length: 120 }, (_, i) => i + 1);
    await findEmbyItems(server.config, { type: 'movie', tmdbIds });
    const batches = server.requests.map((r) => r.query.AnyProviderIdEquals?.split(',').length);
    expect(batches).toEqual([50, 50, 20]);
  });

  it("n'appelle pas Emby sans identifiant", async () => {
    const server = await serve({});
    expect(await findEmbyItems(server.config, { type: 'movie', tmdbIds: [] })).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });
});

describe('getEmbySeasonAvailability', () => {
  it('compte les épisodes présents par saison en ignorant les épisodes virtuels', async () => {
    const server = await serve({ 'GET /Items': episodesFixture });
    expect(await getEmbySeasonAvailability(server.config, '200')).toEqual([
      { seasonNumber: 0, episodesPresent: 1, isSpecials: true },
      { seasonNumber: 1, episodesPresent: 2, isSpecials: false },
      { seasonNumber: 3, episodesPresent: 1, isSpecials: false },
    ]);
    expect(server.requests[0]?.query).toMatchObject({
      ParentId: '200',
      Recursive: 'true',
      IncludeItemTypes: 'Episode',
      Fields: 'LocationType,ParentIndexNumber',
    });
    expect(server.requests[0]?.query.UserId).toBeUndefined();
  });

  it('renvoie une liste vide pour une série sans épisode', async () => {
    const server = await serve({ 'GET /Items': { Items: [] } });
    expect(await getEmbySeasonAvailability(server.config, '9')).toEqual([]);
  });
});

describe('embyWebLink', () => {
  it("construit le lien vers l'interface web d'Emby", () => {
    expect(embyWebLink('http://emby:8096/', 'srv', '42')).toBe(
      'http://emby:8096/web/index.html#!/item?id=42&serverId=srv',
    );
  });
});
