import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { migrationsFolder, openDataDir } from '../src/server/db/index.ts';
import type { TmdbClient } from '../src/server/integrations/tmdb.ts';
import { saveArrServer } from '../src/server/services/arr-servers.ts';
import { createOverrideRule, matchingRules } from '../src/server/services/override-rules.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { type ArrServerInput, arrServerInputSchema } from '../src/shared/arr-servers.ts';
import {
  OVERRIDE_RULES_ORDER_PATH,
  OVERRIDE_RULES_PATH,
  type OverrideRule,
  type OverrideRuleInput,
  overrideRuleInputSchema,
  overrideRulePath,
  ruleLayer,
  ruleMatches,
} from '../src/shared/override-rules.ts';
import { type RequestDetail, resolveSendChoice, type SendOptions } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import type { FakeRoutes } from './fake-server.ts';
import { addArrServer, loginAs, SLOW_TEST, trackFakeServers, trackTempDirs, truncatedMigrations } from './helpers.ts';

// Lot 8.8 : règles de surcharge (Seerr `OverrideRule`) : sémantique, migration 0015, routes, approbation et envoi.

const startServer = trackFakeServers();
const tempDir = trackTempDirs();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const ANIMATION = 16;
const ACTION = 28;
const ANIME_KEYWORD = { id: 210024, name: 'anime' };

const rule = (values: Partial<OverrideRule> & Pick<OverrideRule, 'id' | 'serverId'>): OverrideRule => ({
  name: `Règle ${values.id}`,
  type: 'tv',
  genres: [],
  languages: [],
  keywords: [],
  qualityProfileId: null,
  rootFolderPath: null,
  seriesType: null,
  tags: [],
  enabled: true,
  position: values.id,
  ...values,
});

describe('conditions d’une règle : ET entre les listes, OU dans une liste', () => {
  const title = { genres: [ANIMATION, ACTION], originalLanguage: 'ja', keywords: [ANIME_KEYWORD.id] };
  it.each([
    [{ genres: [ANIMATION] }, true],
    [{ genres: [99, ACTION] }, true],
    [{ genres: [99] }, false],
    [{ languages: ['ko', 'ja'] }, true],
    [{ genres: [ANIMATION], languages: ['fr'] }, false],
    [{ genres: [ANIMATION], languages: ['ja'], keywords: [ANIME_KEYWORD] }, true],
    [{ keywords: [{ id: 1, name: 'autre' }] }, false],
  ])('%j → %s', (conditions, expected) => {
    expect(ruleMatches({ genres: [], languages: [], keywords: [], ...conditions }, title)).toBe(expected);
  });

  it('une langue originale inconnue ne correspond à aucune langue', () => {
    expect(ruleMatches({ genres: [], languages: ['ja'], keywords: [] }, { ...title, originalLanguage: null })).toBe(
      false,
    );
  });

  it('la saisie exige une condition, et refuse un type de série pour un film', () => {
    const base = { name: 'R', type: 'movie' as const, serverId: 1 };
    expect(overrideRuleInputSchema.safeParse(base).success).toBe(false);
    expect(overrideRuleInputSchema.safeParse({ ...base, languages: ['ja'], seriesType: 'anime' }).success).toBe(false);
    expect(overrideRuleInputSchema.safeParse({ ...base, languages: ['ja'] }).success).toBe(true);
  });
});

describe('ordre de priorité avec les règles (resolveSendChoice)', () => {
  const defaults = { qualityProfileId: 1, rootFolderPath: '/defaut', seriesType: 'standard' as const };
  const first = ruleLayer(rule({ id: 1, serverId: 2, rootFolderPath: '/anime' }));
  const second = ruleLayer(rule({ id: 2, serverId: 2, qualityProfileId: 9, rootFolderPath: '/autre' }));
  const elsewhere = ruleLayer(rule({ id: 3, serverId: 4, qualityProfileId: 7 }));

  it('la règle choisit le serveur ; la première l’emporte champ par champ, puis les valeurs du serveur', () => {
    expect(resolveSendChoice({ rules: [first, second], defaults }, 1)).toEqual({
      serverId: 2,
      qualityProfileId: 9,
      rootFolderPath: '/anime',
      seriesType: 'standard',
    });
  });

  it('le choix enregistré et celui de l’approbateur passent avant les règles', () => {
    expect(resolveSendChoice({ stored: { serverId: 2, rootFolderPath: '/a' }, rules: [first], defaults }, 1)).toEqual({
      serverId: 2,
      qualityProfileId: 1,
      rootFolderPath: '/a',
      seriesType: 'standard',
    });
    expect(resolveSendChoice({ approver: { qualityProfileId: 3 }, rules: [second], defaults }, 1)).toMatchObject({
      qualityProfileId: 3,
      rootFolderPath: '/autre',
    });
  });

  it('une règle d’un autre serveur que celui retenu ne joue pas', () => {
    expect(resolveSendChoice({ stored: { serverId: 2 }, rules: [elsewhere, first], defaults }, 1)).toEqual({
      serverId: 2,
      qualityProfileId: 1,
      rootFolderPath: '/anime',
      seriesType: 'standard',
    });
  });
});

// --- Base, routes, approbation et envoi ---

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  original_language: 'en',
  genres: [{ id: ACTION, name: 'Action' }],
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};
const frieren = {
  id: 209867,
  name: 'Frieren',
  first_air_date: '2023-09-29',
  overview: 'Une elfe.',
  original_language: 'ja',
  genres: [{ id: ANIMATION, name: 'Animation' }],
  seasons: [{ season_number: 1, episode_count: 28, air_date: '2023-09-29' }],
  external_ids: { imdb_id: '', tvdb_id: 424536 },
  keywords: { results: [ANIME_KEYWORD] },
};

const arrOptions: FakeRoutes = {
  'GET /api/v3/qualityprofile': [
    { id: 1, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' },
  ],
  'GET /api/v3/rootfolder': [
    { id: 1, path: '/media', freeSpace: 1000 },
    { id: 3, path: '/anime', freeSpace: 2000 },
  ],
};

interface Actor {
  user: { id: string };
  get: (url: string) => Promise<LightMyRequestResponse>;
  send: (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => Promise<LightMyRequestResponse>;
}

async function setup({ radarr = {}, tmdb = {} }: { radarr?: Partial<ArrServerInput>; tmdb?: FakeRoutes } = {}) {
  const servers = {
    tmdb: await startServer({ 'GET /movie/603': matrix, 'GET /tv/209867': frieren, ...tmdb }),
    radarr: await startServer({
      'GET /api/v3/movie': [],
      'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
      'POST /api/v3/movie': { id: 42, hasFile: false, monitored: true },
      ...arrOptions,
    }),
    sonarr: await startServer({
      'GET /api/v3/series': [],
      'GET /api/v3/series/lookup': [{ id: 0, title: 'Frieren', tvdbId: 424536, seasons: [{ seasonNumber: 1 }] }],
      'POST /api/v3/series': { id: 7, monitored: true, seasons: [] },
      ...arrOptions,
    }),
  };
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const radarrServer = addArrServer(data, { type: 'radarr', url: servers.radarr.url, tags: [3], ...radarr });
  const sonarrServer = addArrServer(data, { type: 'sonarr', url: servers.sonarr.url });
  const radarr4k = addArrServer(data, { type: 'radarr', url: servers.radarr.url, is4k: true });
  const app = await buildApp({ data, upstreams: { tmdbUrl: servers.tmdb.url } });
  cleanups.push(() => app.close());
  const as = async (role: Role, id?: string): Promise<Actor> => {
    const { user, headers } = await loginAs(app, role, id);
    return {
      user,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      send: (method, url, payload) => app.inject({ method, url, headers, ...(payload && { payload }) }),
    };
  };
  const owner = await as('owner', 'proprietaire');
  const actionRule: OverrideRuleInput = {
    name: 'Films d’action',
    type: 'movie',
    serverId: radarrServer.id,
    genres: [ACTION],
    qualityProfileId: 5,
    rootFolderPath: '/anime',
    tags: [7, 3],
  };
  return { app, data, servers, as, owner, radarrServer, sonarrServer, radarr4k, actionRule };
}

const posted = (server: { requests: Array<{ method: string; path: string; body: unknown }> }, path: string) =>
  server.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body as Record<string, unknown>);

describe('routes /api/override-rules', () => {
  it('réservées au propriétaire', SLOW_TEST, async () => {
    const { as, actionRule } = await setup();
    for (const role of ['member', 'manager'] as const) {
      const actor = await as(role);
      expect((await actor.get(OVERRIDE_RULES_PATH)).statusCode).toBe(403);
      expect((await actor.send('POST', OVERRIDE_RULES_PATH, actionRule)).statusCode).toBe(403);
    }
  });

  it('ajout, liste ordonnée, nouvel ordre, modification et suppression', SLOW_TEST, async () => {
    const { owner, actionRule, servers } = await setup();
    const created = await owner.send('POST', OVERRIDE_RULES_PATH, actionRule);
    expect(created.statusCode).toBe(201);
    const second = (await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, name: 'B' })).json<OverrideRule>();
    const first = created.json<OverrideRule>();
    expect(first).toMatchObject({ ...actionRule, seriesType: null, enabled: true, position: 0 });
    expect(second.position).toBe(1);

    const reordered = await owner.send('PUT', OVERRIDE_RULES_ORDER_PATH, { ids: [second.id, first.id] });
    expect(reordered.json<OverrideRule[]>().map((r) => r.name)).toEqual(['B', 'Films d’action']);
    expect((await owner.send('PUT', OVERRIDE_RULES_ORDER_PATH, { ids: [first.id] })).statusCode).toBe(400);

    // Désactiver sans toucher au serveur, au profil ni au dossier : Radarr n'est pas rappelé.
    const calls = servers.radarr.requests.length;
    const disabled = await owner.send('PUT', overrideRulePath(first.id), { ...actionRule, enabled: false });
    expect(disabled.json<OverrideRule>()).toMatchObject({ enabled: false, position: 1 });
    expect(servers.radarr.requests.length).toBe(calls);

    expect((await owner.send('DELETE', overrideRulePath(first.id))).statusCode).toBe(204);
    expect((await owner.send('DELETE', overrideRulePath(first.id))).statusCode).toBe(404);
    expect((await owner.get(OVERRIDE_RULES_PATH)).json<OverrideRule[]>().map((r) => r.id)).toEqual([second.id]);
  });

  it(
    'refuse un serveur d’un autre type, un profil ou un dossier inconnu du serveur, une règle sans condition',
    SLOW_TEST,
    async () => {
      const { owner, actionRule, sonarrServer } = await setup();
      const refused = async (patch: Partial<OverrideRuleInput>) =>
        (await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, ...patch })).statusCode;
      expect(await refused({ serverId: sonarrServer.id })).toBe(400);
      expect(await refused({ serverId: 999 })).toBe(400);
      expect(await refused({ qualityProfileId: 99 })).toBe(400);
      expect(await refused({ rootFolderPath: '/nulle-part' })).toBe(400);
      expect(await refused({ genres: [] })).toBe(400);
      expect((await owner.get(OVERRIDE_RULES_PATH)).json()).toEqual([]);
    },
  );

  it('supprimer le serveur supprime ses règles', SLOW_TEST, async () => {
    const { owner, actionRule, radarr4k } = await setup();
    await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, serverId: radarr4k.id });
    await owner.send('POST', OVERRIDE_RULES_PATH, actionRule);
    expect((await owner.send('DELETE', `/api/arr-servers/${radarr4k.id}`)).statusCode).toBe(204);
    expect((await owner.get(OVERRIDE_RULES_PATH)).json<OverrideRule[]>().map((r) => r.name)).toEqual([actionRule.name]);
  });
});

describe('approbation et envoi avec une règle', () => {
  it('approbation manuelle : profil, dossier de la règle, étiquettes fusionnées sans doublon', SLOW_TEST, async () => {
    const { owner, as, servers, actionRule } = await setup();
    await owner.send('POST', OVERRIDE_RULES_PATH, actionRule);
    const member = await as('member');
    const { id } = (await member.send('POST', '/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    const approved = (await owner.send('POST', `/api/requests/${id}/approve`)).json<RequestDetail>();
    expect(approved.status).toBe('sent');
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([
      { qualityProfileId: 5, rootFolderPath: '/anime', tags: [3, 7] },
    ]);
  });

  it('le choix de l’approbateur passe avant la règle', SLOW_TEST, async () => {
    const { owner, as, servers, actionRule } = await setup();
    await owner.send('POST', OVERRIDE_RULES_PATH, actionRule);
    const member = await as('member');
    const { id } = (await member.send('POST', '/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    await owner.send('POST', `/api/requests/${id}/approve`, { qualityProfileId: 1 });
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([{ qualityProfileId: 1, rootFolderPath: '/anime' }]);
  });

  it(
    'approbation automatique : la règle choisit le serveur, le type de série et les étiquettes',
    SLOW_TEST,
    async () => {
      const { owner, servers, sonarrServer, data } = await setup();
      const sonarrBis = addArrServer(data, { type: 'sonarr', url: servers.sonarr.url, name: 'Sonarr animés' });
      expect(sonarrServer.isDefault).toBe(true);
      const created = await owner.send('POST', OVERRIDE_RULES_PATH, {
        name: 'Animés japonais',
        type: 'tv',
        serverId: sonarrBis.id,
        languages: ['ja'],
        keywords: [ANIME_KEYWORD],
        seriesType: 'anime',
        rootFolderPath: '/anime',
        tags: [4],
      });
      expect(created.statusCode).toBe(201);
      const request = await owner.send('POST', '/api/requests', { type: 'tv', tmdbId: 209867, seasons: [1] });
      expect(request.json<RequestDetail>()).toMatchObject({ status: 'sent', server: { id: sonarrBis.id } });
      expect(posted(servers.sonarr, '/api/v3/series')).toMatchObject([
        { seriesType: 'anime', rootFolderPath: '/anime', tags: [4] },
      ]);
    },
  );

  it(
    'demande avancée sans serveur choisi : le profil choisi est gardé avec le serveur de la règle',
    SLOW_TEST,
    async () => {
      const { owner, servers, data, actionRule } = await setup();
      const radarrBis = addArrServer(data, { type: 'radarr', url: servers.radarr.url, name: 'Radarr bis' });
      await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, serverId: radarrBis.id, tags: [] });
      const request = await owner.send('POST', '/api/requests', { type: 'movie', tmdbId: 603, qualityProfileId: 1 });
      expect(request.json<RequestDetail>()).toMatchObject({ status: 'sent', server: { id: radarrBis.id } });
      expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([
        { qualityProfileId: 1, rootFolderPath: '/anime' },
      ]);
    },
  );

  it('une règle désactivée, d’un autre type ou qui ne correspond pas ne joue pas', SLOW_TEST, async () => {
    const { owner, as, servers, actionRule } = await setup();
    await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, enabled: false });
    await owner.send('POST', OVERRIDE_RULES_PATH, { ...actionRule, genres: [ANIMATION] });
    const member = await as('member');
    const { id } = (await member.send('POST', '/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    await owner.send('POST', `/api/requests/${id}/approve`);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([
      { qualityProfileId: 1, rootFolderPath: '/media', tags: [3] },
    ]);
  });

  it('les options d’approbation montrent la règle et ses valeurs', SLOW_TEST, async () => {
    const { owner, actionRule, radarrServer } = await setup();
    const { id } = (await owner.send('POST', OVERRIDE_RULES_PATH, actionRule)).json<OverrideRule>();
    const options = (await owner.get('/api/requests/send-options/movie?is4k=false&tmdbId=603')).json<SendOptions>();
    expect(options).toMatchObject({
      serverId: radarrServer.id,
      defaultProfileId: 5,
      defaultFolder: '/anime',
      rules: [{ id, name: actionRule.name }],
    });
    const plain = (await owner.get('/api/requests/send-options/movie?is4k=false')).json<SendOptions>();
    expect(plain).toMatchObject({ defaultProfileId: 1, defaultFolder: '/media', rules: [] });
  });

  it('approbation par lot : profil, dossier et étiquettes de la règle', SLOW_TEST, async () => {
    const { owner, as, servers, actionRule } = await setup();
    await owner.send('POST', OVERRIDE_RULES_PATH, actionRule);
    const member = await as('member');
    const { id } = (await member.send('POST', '/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();
    expect((await owner.send('POST', '/api/requests/batch', { action: 'approve', ids: [id] })).statusCode).toBe(200);
    expect(posted(servers.radarr, '/api/v3/movie')).toMatchObject([
      { qualityProfileId: 5, rootFolderPath: '/anime', tags: [3, 7] },
    ]);
  });

  it(
    'options d’envoi en cache par serveur : un appel pour des demandes simultanées, oublié à la modification',
    SLOW_TEST,
    async () => {
      const { owner, servers, radarrServer, data } = await setup();
      const profileCalls = () =>
        servers.radarr.requests.filter((r) => r.method === 'GET' && r.path === '/api/v3/qualityprofile').length;
      const options = () => owner.get('/api/requests/send-options/movie?is4k=false&tmdbId=603');
      const before = profileCalls();
      const responses = await Promise.all(Array.from({ length: 10 }, options));
      expect(responses.every((res) => res.statusCode === 200)).toBe(true);
      expect(profileCalls()).toBe(before + 1);

      const { id, apiKey, ...values } = radarrServer;
      saveArrServer(data, arrServerInputSchema.parse({ ...values, apiKey, name: 'Radarr renommé' }), id);
      const afterUpdate = profileCalls();
      await options();
      expect(profileCalls()).toBe(afterUpdate + 1);
    },
  );

  it('TMDB injoignable : on continue sans les règles', SLOW_TEST, async () => {
    const { data, actionRule } = await setup();
    createOverrideRule(data.db, overrideRuleInputSchema.parse(actionRule));
    const down = (() => {
      throw new Error('TMDB en panne');
    }) as () => TmdbClient;
    expect(await matchingRules(data, down, 'movie', false, 603)).toEqual([]);
  });
});

describe('migration 0015 sur une base 0014 peuplée', () => {
  it('crée la table sans toucher aux serveurs ; contraintes et cascade', SLOW_TEST, () => {
    const dir = tempDir();
    const sqlite = new Database(join(dir, 'base.db'));
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(dir, 15) });
    sqlite
      .prepare(
        `INSERT INTO arr_servers (id, type, name, url, api_key, is_default, quality_profile_id, root_folder_path, tags)
         VALUES (1, 'sonarr', 'Sonarr', 'http://s', 'k', 1, 1, '/tv', '[2]')`,
      )
      .run();
    migrate(drizzle({ client: sqlite }), { migrationsFolder });
    expect(sqlite.prepare('SELECT name, tags FROM arr_servers').all()).toEqual([{ name: 'Sonarr', tags: '[2]' }]);

    const insert = (values: string) =>
      sqlite
        .prepare(`INSERT INTO override_rules (name, type, server_id, genres, series_type, position) VALUES ${values}`)
        .run();
    insert(`('Animés', 'tv', 1, '[16]', 'anime', 0)`);
    expect(() => insert(`('Film', 'movie', 1, '[16]', 'anime', 1)`)).toThrow(/CHECK/);
    expect(() => insert(`('Mauvais JSON', 'tv', 1, '{"a":1}', NULL, 1)`)).toThrow(/CHECK/);
    expect(() => insert(`('Sans serveur', 'tv', 9, '[]', NULL, 1)`)).toThrow(/FOREIGN KEY/);
    expect(sqlite.prepare('SELECT languages, keywords, tags, enabled FROM override_rules').get()).toEqual({
      languages: '[]',
      keywords: '[]',
      tags: '[]',
      enabled: 1,
    });
    sqlite.prepare('DELETE FROM arr_servers WHERE id = 1').run();
    expect(sqlite.prepare('SELECT count(*) AS n FROM override_rules').get()).toEqual({ n: 0 });
    sqlite.close();
  });
});
