import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { settings } from '../src/server/db/schema.ts';
import { createTmdb } from '../src/server/integrations/tmdb.ts';
import { TtlLru } from '../src/server/lib/lru.ts';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import { builtInRowIds, resolveLayout } from '../src/shared/discover-layout.ts';
import { settingSchemas } from '../src/shared/settings.ts';
import { type FakeRoutes, startFakeServer } from './fake-server.ts';
import { loginAs, loginAsOwner, trackTempDirs } from './helpers.ts';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/tmdb/${name}.json`, import.meta.url), 'utf8'));

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const LAYOUT = '/api/settings/discover-layout';
const LOCALE = '/api/settings/tmdb-locale';
const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(routes: FakeRoutes = {}) {
  const server = await startFakeServer(routes);
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const app = await buildApp({ data, upstreams: { tmdbUrl: server.url } });
  cleanups.push(() => app.close(), server.close);
  const owner = (await loginAsOwner(app)).headers;
  const member = (await loginAs(app, 'member')).headers;
  const call = (headers: Record<string, string>) => (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
  return { app, data, server, asOwner: call(owner), asMember: call(member) };
}

const page = (results: unknown[]) => ({ page: 1, total_pages: 1, results });
const movie = { id: 603, title: 'Matrix', release_date: '1999-03-30', poster_path: '/p.jpg' };
const show = { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' };
const discoverRoutes = (overrides: FakeRoutes = {}): FakeRoutes => ({
  'GET /trending/all/week': page([{ ...movie, media_type: 'movie' }]),
  'GET /movie/popular': page([movie]),
  'GET /tv/popular': page([show]),
  'GET /movie/upcoming': page([{ id: 7, title: 'Bientôt', release_date: '2027-01-01' }]),
  ...overrides,
});

const builtin = (id: string, enabled = true) => ({ kind: 'builtin', id, enabled });
const custom = (overrides: Record<string, unknown> = {}) => ({
  kind: 'custom',
  id: 'custom-abc123',
  title: 'Science-fiction récente',
  type: 'movie',
  filters: { genres: [878, 12], yearFrom: 2020, sort: 'rating' },
  enabled: true,
  ...overrides,
});
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe('réglage discoverLayout', () => {
  it('jamais enregistré : toutes les rangées dans l’ordre de la page, actives', async () => {
    const { asOwner } = await setup();
    const res = await asOwner('GET', LAYOUT);

    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual(builtInRowIds.map((id) => builtin(id)));
  });

  it('enregistre l’ordre et l’état ; une rangée absente est ajoutée à la fin', async () => {
    const { asOwner } = await setup();
    const saved = await asOwner('PUT', LAYOUT, { rows: [builtin('upcoming'), builtin('trending', false), custom()] });

    expect(saved.statusCode).toBe(200);
    const { rows } = (await asOwner('GET', LAYOUT)).json();
    expect(ids(rows)).toEqual([
      'upcoming',
      'trending',
      'custom-abc123',
      ...builtInRowIds.filter((id) => id !== 'upcoming' && id !== 'trending'),
    ]);
    expect(rows[1]).toEqual(builtin('trending', false));
    expect(rows[2]).toEqual(custom());
  });

  it('un réglage enregistré avec une rangée de l’appli inconnue se lit en l’ignorant ; l’écriture la refuse', async () => {
    const { asOwner, data } = await setup();
    const stored = { rows: [{ kind: 'builtin', id: 'retiree', enabled: true }, builtin('upcoming', false)] };
    data.db
      .insert(settings)
      .values({ key: 'discoverLayout', value: JSON.stringify(stored) })
      .run();

    const res = await asOwner('GET', LAYOUT);
    expect(res.statusCode).toBe(200);
    expect(ids(res.json().rows)).toEqual(['upcoming', ...builtInRowIds.filter((id) => id !== 'upcoming')]);
    expect((await asOwner('PUT', LAYOUT, stored)).statusCode).toBe(400);
  });

  it('un membre ne lit ni n’écrit les réglages (403)', async () => {
    const { asMember } = await setup();

    for (const url of [LAYOUT, LOCALE]) {
      expect((await asMember('GET', url)).statusCode).toBe(403);
      expect((await asMember('PUT', url, {})).statusCode).toBe(403);
    }
  });

  it.each([
    ['identifiants en double', { rows: [builtin('trending'), builtin('trending', false)] }],
    ['rangée de l’appli inconnue', { rows: [builtin('nouveautes')] }],
    ['titre vide', { rows: [custom({ title: '   ' })] }],
    ['titre trop long', { rows: [custom({ title: 'x'.repeat(61) })] }],
    ['identifiant sans le préfixe custom-', { rows: [custom({ id: 'trending' })] }],
    ['type inconnu', { rows: [custom({ type: 'anime' })] }],
    ['bornes d’années inversées', { rows: [custom({ filters: { yearFrom: 2020, yearTo: 2010 } })] }],
    ['genre invalide', { rows: [custom({ filters: { genres: ['x'] } })] }],
    ['note hors limites', { rows: [custom({ filters: { rating: 11 } })] }],
    [
      'plus de 20 rangées sur mesure',
      { rows: Array.from({ length: 21 }, (_, i) => custom({ id: `custom-row${String(i).padStart(3, '0')}` })) },
    ],
    ['corps qui n’est pas un objet', []],
  ])('refuse : %s (400, rien d’enregistré)', async (_name, body) => {
    const { asOwner, data } = await setup();
    const res = await asOwner('PUT', LAYOUT, body);

    expect(res.statusCode).toBe(400);
    expect(getSetting(data.db, data.cryptoKey, 'discoverLayout')).toBeNull();
  });

  it('les filtres d’une rangée sur mesure se relisent tels quels (un ou plusieurs genres)', async () => {
    const { data } = await setup();
    const rows = [
      custom({ filters: { genres: [28, 12], runtimeMin: 90 } }),
      custom({ id: 'custom-solo01', filters: { genres: [28] } }),
    ];
    setSetting(data.db, data.cryptoKey, 'discoverLayout', { rows: rows as never });
    const stored = getSetting(data.db, data.cryptoKey, 'discoverLayout')?.rows ?? [];

    expect(stored.slice(0, 2)).toMatchObject([
      { filters: { genres: [28, 12], runtimeMin: 90 } },
      { filters: { genres: [28] } },
    ]);
  });

  it('resolveLayout ignore un doublon et complète avec les rangées manquantes', () => {
    const resolved = resolveLayout([
      { kind: 'builtin', id: 'upcoming', enabled: false },
      { kind: 'builtin', id: 'upcoming', enabled: true },
    ]);

    expect(ids(resolved)).toEqual(['upcoming', ...builtInRowIds.filter((id) => id !== 'upcoming')]);
    expect(resolved[0]).toEqual(builtin('upcoming', false));
  });
});

describe('réglage tmdbLocale', () => {
  it('jamais enregistré : fr-FR et FR', async () => {
    const { asOwner } = await setup();

    expect((await asOwner('GET', LOCALE)).json()).toEqual({ language: 'fr-FR', region: 'FR' });
  });

  it('enregistre la langue et la région', async () => {
    const { asOwner } = await setup();
    const saved = await asOwner('PUT', LOCALE, { language: 'pt-BR', region: 'BR' });

    expect(saved.json()).toEqual({ language: 'pt-BR', region: 'BR' });
    expect((await asOwner('GET', LOCALE)).json()).toEqual({ language: 'pt-BR', region: 'BR' });
  });

  it.each([
    { language: 'fr', region: 'FR' },
    { language: 'xx-XX', region: 'FR' },
    { language: 'fr-FR', region: 'fr' },
    { language: 'fr-FR', region: 'ZZ' },
  ])('refuse %j (400)', async (body) => {
    const { asOwner, data } = await setup();

    expect((await asOwner('PUT', LOCALE, body)).statusCode).toBe(400);
    expect(getSetting(data.db, data.cryptoKey, 'tmdbLocale')).toBeNull();
  });

  it('le schéma complète une valeur partielle', () => {
    expect(settingSchemas.tmdbLocale.parse({ region: 'BE' })).toEqual({ language: 'fr-FR', region: 'BE' });
  });
});

describe('GET /api/discover : rangées configurées', () => {
  it('par défaut : l’ordre habituel, les rangées à logos dans `layout`', async () => {
    const { asMember } = await setup(discoverRoutes());
    const body = (await asMember('GET', '/api/discover')).json();

    expect(ids(body.rows)).toEqual(['trending', 'popular-movies', 'popular-tv', 'upcoming']);
    expect(body.layout).toEqual(builtInRowIds);
  });

  it('un membre voit l’ordre choisi ; une rangée désactivée n’appelle pas TMDB', async () => {
    const { asOwner, asMember, server } = await setup(discoverRoutes());
    await asOwner('PUT', LAYOUT, {
      rows: [
        builtin('upcoming'),
        builtin('popular-tv'),
        builtin('providers'),
        builtin('trending', false),
        builtin('popular-movies', false),
      ],
    });
    const body = (await asMember('GET', '/api/discover')).json();

    expect(ids(body.rows)).toEqual(['upcoming', 'popular-tv']);
    expect(body.layout).toEqual([
      'upcoming',
      'popular-tv',
      'providers',
      'recent-requests',
      'emby-recent',
      'studios',
      'networks',
    ]);
    expect(server.requests.map((r) => r.path).sort()).toEqual(['/movie/upcoming', '/tv/popular']);
  });

  it('une rangée sur mesure charge /discover avec ses filtres et renvoie le lien « Tout voir »', async () => {
    const { asOwner, asMember, server } = await setup(
      discoverRoutes({ 'GET /discover/movie': fixture('trending-movie') }),
    );
    await asOwner('PUT', LAYOUT, { rows: [custom(), builtin('trending', false)] });
    const body = (await asMember('GET', '/api/discover')).json();

    const row = body.rows.find((r: { id: string }) => r.id === 'custom-abc123');
    expect(row).toMatchObject({
      title: 'Science-fiction récente',
      items: [{ tmdbId: 603, type: 'movie' }],
      seeAll: { type: 'movie', filters: { genres: [878, 12], yearFrom: 2020, sort: 'rating' } },
    });
    expect(ids(body.rows).indexOf('custom-abc123')).toBe(0);
    const request = server.requests.find((r) => r.path === '/discover/movie');
    expect(request?.query).toMatchObject({
      sort_by: 'vote_average.desc',
      with_genres: '878,12',
      'primary_release_date.gte': '2020-01-01',
      'vote_count.gte': '200',
      page: '1',
    });
  });

  it('une rangée sur mesure de séries utilise les paramètres des séries', async () => {
    const { asOwner, asMember, server } = await setup(
      discoverRoutes({ 'GET /discover/tv': fixture('trending-movie') }),
    );
    await asOwner('PUT', LAYOUT, {
      rows: [custom({ type: 'tv', filters: { network: 213, yearTo: 2015, company: 5 } })],
    });
    await asMember('GET', '/api/discover');

    expect(server.requests.find((r) => r.path === '/discover/tv')?.query).toMatchObject({
      with_networks: '213',
      'first_air_date.lte': '2015-12-31',
    });
    expect(server.requests.find((r) => r.path === '/discover/tv')?.query).not.toHaveProperty('with_companies');
  });

  it('les mots-clés bloqués sont écartés de la rangée d’un membre', async () => {
    const { asOwner, asMember, data, server } = await setup(
      discoverRoutes({ 'GET /discover/movie': fixture('trending-movie') }),
    );
    setSetting(data.db, data.cryptoKey, 'blockedKeywords', { keywords: [{ id: 99, name: 'gore' }] });
    await asOwner('PUT', LAYOUT, { rows: [custom()] });

    await asMember('GET', '/api/discover');
    expect(server.requests.find((r) => r.path === '/discover/movie')?.query).toMatchObject({ without_keywords: '99' });
  });

  it('une rangée sur mesure en échec est omise, les autres restent', async () => {
    const { asOwner, asMember } = await setup(discoverRoutes());
    await asOwner('PUT', LAYOUT, { rows: [custom()] });
    const res = await asMember('GET', '/api/discover');

    expect(res.statusCode).toBe(200);
    expect(ids(res.json().rows)).not.toContain('custom-abc123');
    expect(ids(res.json().rows)).toContain('trending');
  });
});

describe('langue et région de TMDB', () => {
  const detailsRoutes = (): FakeRoutes => ({
    'GET /movie/603': fixture('movie'),
    'GET /movie/upcoming': page([{ id: 7, title: 'Bientôt' }]),
    'GET /discover/movie': fixture('trending-movie'),
    'GET /discover/tv': fixture('trending-movie'),
    'GET /watch/providers/movie': {
      results: [{ provider_id: 8, provider_name: 'Netflix', display_priorities: { US: 1 } }],
    },
  });

  it('par défaut : fr-FR et FR sur tous les appels', async () => {
    const { asMember, server } = await setup(detailsRoutes());
    await asMember('GET', '/api/media/movie/603');
    await asMember('GET', '/api/providers/movie');

    for (const request of server.requests) expect(request.query.language).toBe('fr-FR');
    expect(server.requests.find((r) => r.path === '/watch/providers/movie')?.query).toMatchObject({
      watch_region: 'FR',
    });
  });

  it('en anglais, une fiche au titre vide n’appelle pas le repli en-US (déjà la langue demandée)', async () => {
    const { asOwner, asMember, server } = await setup({ 'GET /movie/700': fixture('movie-blank-fr') });
    await asOwner('PUT', LOCALE, { language: 'en-GB', region: 'GB' });
    await asMember('GET', '/api/media/movie/700');

    expect(server.requests.map((r) => r.query.language)).toEqual(['en-GB']);
  });

  it('un changement de réglage s’applique aussitôt, sans servir l’ancienne langue depuis le cache', async () => {
    const { asOwner, asMember, server } = await setup(detailsRoutes());
    await asMember('GET', '/api/media/movie/603');
    await asOwner('PUT', LOCALE, { language: 'en-US', region: 'US' });
    const res = await asMember('GET', '/api/media/movie/603');

    const details = server.requests.filter((r) => r.path === '/movie/603');
    expect(details.map((r) => r.query.language)).toEqual(['fr-FR', 'en-US']);
    // région US : plateformes des États-Unis ; bande-annonce anglaise
    expect(res.json()).toMatchObject({
      watchProviders: { flatrate: [{ id: 9, name: 'Prime Video' }], rent: [], buy: [] },
      trailerKey: 'enTrailer',
    });
    expect(details[1]?.query.include_video_language).toBe('en,en,null');
  });

  it('la région s’applique aux prochaines sorties, aux plateformes et aux filtres de streaming', async () => {
    const { asOwner, asMember, server } = await setup(detailsRoutes());
    await asOwner('PUT', LOCALE, { language: 'fr-CA', region: 'CA' });
    await asMember('GET', '/api/discover');
    await asMember('GET', '/api/providers/movie');
    await asMember('GET', '/api/discover/movie?provider=8');
    await asMember('GET', '/api/discover/tv/provider/8');

    expect(server.requests.find((r) => r.path === '/movie/upcoming')?.query).toMatchObject({
      region: 'CA',
      language: 'fr-CA',
    });
    expect(server.requests.find((r) => r.path === '/watch/providers/movie')?.query.watch_region).toBe('CA');
    const discover = server.requests.filter((r) => r.path.startsWith('/discover/'));
    expect(discover.map((r) => r.path)).toEqual(['/discover/movie', '/discover/tv']);
    for (const request of discover) expect(request.query).toMatchObject({ watch_region: 'CA', language: 'fr-CA' });
  });

  it('la même adresse n’est jamais partagée entre deux langues (clé du cache)', async () => {
    const server = await startFakeServer({ 'GET /movie/upcoming': page([{ id: 7, title: 'Bientôt' }]) });
    cleanups.push(server.close);
    const cache = new TtlLru({ maxEntries: 100 });
    const config = { apiKey: V3_KEY, baseUrl: server.url };

    await createTmdb({ ...config, language: 'fr-FR', region: 'FR' }, cache).upcoming();
    await createTmdb({ ...config, language: 'fr-FR', region: 'FR' }, cache).upcoming();
    await createTmdb({ ...config, language: 'ja-JP', region: 'FR' }, cache).upcoming();
    await createTmdb({ ...config, language: 'fr-FR', region: 'BE' }, cache).upcoming();

    expect(server.requests.map((r) => [r.query.language, r.query.region])).toEqual([
      ['fr-FR', 'FR'],
      ['ja-JP', 'FR'],
      ['fr-FR', 'BE'],
    ]);
  });
});
