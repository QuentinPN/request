import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { media, requests, watchlist } from '../src/server/db/schema.ts';
import { IMPORT_LIMIT } from '../src/server/routes/watchlist.ts';
import { setSetting } from '../src/server/services/settings.ts';
import {
  importPath,
  TRAKT_SETTINGS_PATH,
  WATCHLIST_PAGE_SIZE,
  WATCHLIST_PATH,
  type WatchlistImportResult,
  type WatchlistPage,
  watchlistItemPath,
} from '../src/shared/watchlist.ts';
import { type FakeHandler, type FakeRoutes, startFakeServer, status } from './fake-server.ts';
import { loginAs, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';
const CLIENT_ID = 'client-id-trakt-secret';

const matrix = { id: 603, title: 'Matrix', release_date: '1999-03-30', poster_path: '/matrix.jpg' };
const heat = { id: 949, title: 'Heat', original_title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg' };
const tmdbRoutes: FakeRoutes = {
  'GET /movie/603': matrix,
  'GET /movie/949': heat,
  'GET /tv/1396': { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/bb.jpg' },
};

/** Appli branchée sur de faux TMDB et Trakt ; deux membres connectés. */
async function setup({ tmdb = tmdbRoutes, trakt = {} as FakeRoutes } = {}) {
  const tmdbServer = await startFakeServer(tmdb);
  const traktServer = await startFakeServer(trakt);
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdbServer.url, traktUrl: traktServer.url } });
  cleanups.push(() => app.close(), tmdbServer.close, traktServer.close);
  const member = await loginAs(app, 'member', 'alice');
  const other = await loginAs(app, 'member', 'bob');
  const owner = await loginAs(app, 'owner', 'proprio');
  const as =
    (session: { headers: Record<string, string> }) =>
    (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: session.headers,
        ...(payload !== undefined && { payload: payload as object }),
      });
  return {
    app,
    data,
    tmdbServer,
    traktServer,
    member,
    other,
    owner,
    alice: as(member),
    bob: as(other),
    proprio: as(owner),
  };
}

describe('liste de souhaits : ajout, lecture, retrait', () => {
  it('exige une session', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: WATCHLIST_PATH })).statusCode).toBe(401);
  });

  it('ajoute un titre une seule fois (idempotent), avec la copie TMDB, et le retire', async () => {
    const { alice, data, member } = await setup();

    expect((await alice('GET', watchlistItemPath('movie', 603))).json()).toEqual({ inList: false });
    for (let i = 0; i < 2; i++) {
      const res = await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 603 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inList: true });
    }
    expect((await alice('GET', watchlistItemPath('movie', 603))).json()).toEqual({ inList: true });
    expect(data.db.select().from(watchlist).all()).toMatchObject([
      {
        userId: member.user.id,
        mediaType: 'movie',
        tmdbId: 603,
        title: 'Matrix',
        year: 1999,
        posterPath: '/matrix.jpg',
        source: 'manual',
      },
    ]);

    for (let i = 0; i < 2; i++)
      expect((await alice('DELETE', watchlistItemPath('movie', 603))).json()).toEqual({ inList: false });
    expect(data.db.select().from(watchlist).all()).toEqual([]);
  });

  it('chaque membre a sa liste : rien d’un autre n’est lu ni retiré', async () => {
    const { alice, bob } = await setup();
    await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 603 });

    expect((await bob('GET', watchlistItemPath('movie', 603))).json()).toEqual({ inList: false });
    expect((await bob('GET', WATCHLIST_PATH)).json()).toMatchObject({ total: 0, results: [] });
    await bob('DELETE', watchlistItemPath('movie', 603));
    expect((await alice('GET', watchlistItemPath('movie', 603))).json()).toEqual({ inList: true });
  });

  it('un film et une série de même identifiant sont deux titres', async () => {
    const { alice } = await setup({
      tmdb: { 'GET /movie/1396': matrix, 'GET /tv/1396': tmdbRoutes['GET /tv/1396'] as Record<string, unknown> },
    });
    await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 1396 });
    await alice('POST', WATCHLIST_PATH, { type: 'tv', tmdbId: 1396 });
    expect((await alice('GET', WATCHLIST_PATH)).json()).toMatchObject({ total: 2 });
  });

  it('refuse une requête invalide (400) et un titre inconnu de TMDB (404, rien n’est écrit)', async () => {
    const { alice, data } = await setup();
    expect((await alice('POST', WATCHLIST_PATH, { type: 'person', tmdbId: 1 })).statusCode).toBe(400);
    expect((await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: -3 })).statusCode).toBe(400);
    expect((await alice('GET', '/api/watchlist/movie/abc')).statusCode).toBe(400);
    const unknown = await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Titre introuvable' });
    expect(data.db.select().from(watchlist).all()).toEqual([]);
  });

  it('liste les plus récents d’abord, avec le statut calculé comme sur les affiches', async () => {
    const { alice, data, member } = await setup();
    await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 603 });
    await alice('POST', WATCHLIST_PATH, { type: 'movie', tmdbId: 949 });
    // Matrix est demandé (approuvé), Heat en attente : le statut des affiches est commun à tous les membres.
    for (const [tmdbId, requestStatus] of [
      [603, 'approved'],
      [949, 'pending'],
    ] as const) {
      const row = data.db
        .insert(media)
        .values({ type: 'movie', tmdbId, statusUpdatedAt: new Date() })
        .returning({ id: media.id })
        .get();
      data.db.insert(requests).values({ mediaId: row.id, userId: member.user.id, status: requestStatus }).run();
    }

    const page = (await alice('GET', WATCHLIST_PATH)).json() as WatchlistPage;

    expect(page).toMatchObject({ page: 1, totalPages: 1, total: 2 });
    expect(page.results.map((r) => [r.title, r.status ?? null, r.source])).toEqual([
      ['Heat', 'pending', 'manual'],
      ['Matrix', 'requested', 'manual'],
    ]);
    expect(page.results[0]?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('pagine par 40 et complète au passage les copies sans affiche (import Trakt)', async () => {
    const { alice, data, member, tmdbServer } = await setup();
    const rows = Array.from({ length: WATCHLIST_PAGE_SIZE + 5 }, (_, i) => ({
      userId: member.user.id,
      mediaType: 'movie' as const,
      tmdbId: 10_000 + i,
      title: `Film ${i}`,
      posterPath: '/p.jpg',
    }));
    data.db.insert(watchlist).values(rows).run();
    data.db
      .insert(watchlist)
      .values({ userId: member.user.id, mediaType: 'movie', tmdbId: 603, source: 'trakt' })
      .run();

    const first = (await alice('GET', WATCHLIST_PATH)).json() as WatchlistPage;
    const second = (await alice('GET', `${WATCHLIST_PATH}?page=2`)).json() as WatchlistPage;

    expect(first).toMatchObject({ totalPages: 2, total: WATCHLIST_PAGE_SIZE + 6 });
    expect(first.results).toHaveLength(WATCHLIST_PAGE_SIZE);
    expect(second.results).toHaveLength(6);
    // Matrix (importé sans copie) est lu chez TMDB et sa copie est enregistrée.
    const matrixRow = [...first.results, ...second.results].find((r) => r.tmdbId === 603);
    expect(matrixRow).toMatchObject({ title: 'Matrix', posterPath: '/matrix.jpg', source: 'trakt' });
    expect(
      data.db
        .select()
        .from(watchlist)
        .where(and(eq(watchlist.tmdbId, 603)))
        .get(),
    ).toMatchObject({
      title: 'Matrix',
      posterPath: '/matrix.jpg',
    });
    expect(tmdbServer.requests.filter((r) => r.path.startsWith('/movie/')).length).toBe(1);
  });
});

describe('import Trakt', () => {
  const watchlistPath = '/users/alice-trakt/watchlist/movie,show/added';
  const items = [
    { type: 'movie', movie: { title: 'Matrix', year: 1999, ids: { tmdb: 603 } } },
    { type: 'show', show: { title: 'Breaking Bad', year: 2008, ids: { tmdb: 1396 } } },
    { type: 'movie', movie: { title: 'Film sans id', year: 2020, ids: {} } },
  ];
  const onePage =
    (list: unknown[]): FakeHandler =>
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.query.page === '1' ? list : []));
    };
  const configure = (data: ReturnType<typeof openDataDir>) =>
    setSetting(data.db, data.cryptoKey, 'trakt', { clientId: CLIENT_ID });

  it('sans Client ID enregistré : 409 lisible', async () => {
    const { alice } = await setup();
    const res = await alice('POST', importPath('trakt'), { username: 'alice-trakt' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Client ID Trakt/);
  });

  it('aperçu (rien d’écrit) puis import ; relancer ne crée aucun doublon', async () => {
    const { alice, data, member } = await setup({ trakt: { [`GET ${watchlistPath}`]: onePage(items) } });
    configure(data);
    data.db
      .insert(watchlist)
      .values({ userId: member.user.id, mediaType: 'movie', tmdbId: 603, title: 'Matrix' })
      .run();

    const preview = (
      await alice('POST', `${importPath('trakt')}?dryRun=1`, { username: 'alice-trakt' })
    ).json() as WatchlistImportResult;
    expect(preview).toEqual({
      dryRun: true,
      source: 'trakt',
      total: 3,
      truncated: false,
      imported: 1,
      alreadyInList: 1,
      skipped: [{ title: 'Film sans id', year: 2020, reason: 'no_tmdb_id' }],
    });
    expect(data.db.select().from(watchlist).all()).toHaveLength(1);

    const done = (
      await alice('POST', importPath('trakt'), { username: 'alice-trakt' })
    ).json() as WatchlistImportResult;
    expect(done).toMatchObject({ dryRun: false, imported: 1, alreadyInList: 1 });
    expect(data.db.select().from(watchlist).where(eq(watchlist.source, 'trakt')).all()).toMatchObject([
      { userId: member.user.id, mediaType: 'tv', tmdbId: 1396, title: 'Breaking Bad', year: 2008, posterPath: null },
    ]);

    const again = (
      await alice('POST', importPath('trakt'), { username: 'alice-trakt' })
    ).json() as WatchlistImportResult;
    expect(again).toMatchObject({ imported: 0, alreadyInList: 2 });
    expect(data.db.select().from(watchlist).all()).toHaveLength(2);
  });

  it('refuse un nom d’utilisateur invalide', async () => {
    const { alice, data, traktServer } = await setup();
    configure(data);
    expect((await alice('POST', importPath('trakt'), { username: '../etc' })).statusCode).toBe(400);
    expect(traktServer.requests).toHaveLength(0);
  });

  it('profil introuvable ou privé : 422 au message lisible', async () => {
    const { alice, data } = await setup({
      trakt: {
        'GET /users/ghost/watchlist/movie,show/added': status(404),
        'GET /users/prive/watchlist/movie,show/added': status(401),
        'GET /movies/trending': [],
      },
    });
    configure(data);

    const ghost = await alice('POST', `${importPath('trakt')}?dryRun=1`, { username: 'ghost' });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().error).toMatch(/introuvable ou privée/);
    const priv = await alice('POST', `${importPath('trakt')}?dryRun=1`, { username: 'prive' });
    expect(priv.statusCode).toBe(422);
    expect(priv.json().error).toMatch(/introuvable ou privée/);
  });

  it('Client ID refusé par Trakt : 422 qui renvoie au propriétaire', async () => {
    const { alice, data } = await setup({
      trakt: { 'GET /users/alice-trakt/watchlist/movie,show/added': status(403), 'GET /movies/trending': status(403) },
    });
    configure(data);
    const res = await alice('POST', `${importPath('trakt')}?dryRun=1`, { username: 'alice-trakt' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/refuse le Client ID/);
  });
});

describe('import Letterboxd', () => {
  const csv = [
    'Date,Name,Year,Letterboxd URI',
    '2024-01-01,Matrix,1999,https://boxd.it/a',
    '2024-01-02,Heat,1995,https://boxd.it/b',
    '2024-01-03,Inconnu,2001,https://boxd.it/c',
    '2024-01-04,Heat,2010,https://boxd.it/d',
  ].join('\n');
  const search: FakeRoutes = {
    ...tmdbRoutes,
    'GET /search/movie': (req, res) => {
      const results = req.query.query === 'Matrix' ? [matrix] : req.query.query === 'Heat' ? [heat] : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ page: 1, total_pages: 1, results }));
    },
  };

  it('aperçu (trouvés, ambigus, introuvables) puis import idempotent, source enregistrée', async () => {
    const { alice, data, member } = await setup({ tmdb: search });

    const preview = (
      await alice('POST', `${importPath('letterboxd')}?dryRun=1`, { csv })
    ).json() as WatchlistImportResult;
    expect(preview).toEqual({
      dryRun: true,
      source: 'letterboxd',
      total: 4,
      truncated: false,
      imported: 2,
      alreadyInList: 0,
      skipped: [
        { title: 'Inconnu', year: 2001, reason: 'not_found' },
        { title: 'Heat', year: 2010, reason: 'ambiguous' },
      ],
    });
    expect(data.db.select().from(watchlist).all()).toEqual([]);

    const done = (await alice('POST', importPath('letterboxd'), { csv })).json() as WatchlistImportResult;
    expect(done).toMatchObject({ dryRun: false, imported: 2 });
    expect(data.db.select().from(watchlist).all()).toMatchObject([
      {
        userId: member.user.id,
        mediaType: 'movie',
        tmdbId: 603,
        title: 'Matrix',
        posterPath: '/matrix.jpg',
        source: 'letterboxd',
      },
      { tmdbId: 949, title: 'Heat', source: 'letterboxd' },
    ]);

    const again = (await alice('POST', importPath('letterboxd'), { csv })).json() as WatchlistImportResult;
    expect(again).toMatchObject({ imported: 0, alreadyInList: 2 });
    expect(data.db.select().from(watchlist).all()).toHaveLength(2);
  });

  it('fichier d’un autre format, vide ou trop long : refusé avant toute recherche', async () => {
    const { alice, tmdbServer } = await setup({ tmdb: search });
    const wrong = await alice('POST', importPath('letterboxd'), { csv: 'a,b\n1,2' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toMatch(/watchlist\.csv/);
    expect((await alice('POST', importPath('letterboxd'), { csv: '' })).statusCode).toBe(400);
    const long = `Name,Year\n${Array.from({ length: 1001 }, (_, i) => `Film ${i},2000`).join('\n')}`;
    const res = await alice('POST', importPath('letterboxd'), { csv: long });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/1000 titres/);
    expect(tmdbServer.requests).toHaveLength(0);
  });

  it('un seul import à la fois par membre (409), verrou libéré ensuite ; 10 imports par fenêtre (429)', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FakeHandler = (_req, res) => {
      void gate.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
      });
    };
    const { alice, bob, data, traktServer } = await setup({
      trakt: { [`GET ${'/users/alice-trakt/watchlist/movie,show/added'}`]: slow },
    });
    setSetting(data.db, data.cryptoKey, 'trakt', { clientId: CLIENT_ID });
    const first = alice('POST', `${importPath('trakt')}?dryRun=1`, { username: 'alice-trakt' });
    await vi.waitFor(() => expect(traktServer.requests).toHaveLength(1));
    const second = await alice('POST', importPath('letterboxd'), { csv });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/déjà en cours/);
    expect((await bob('POST', importPath('letterboxd'), { csv: 'a,b\n1,2' })).statusCode).toBe(422);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await alice('POST', importPath('letterboxd'), { csv: 'a,b\n1,2' })).statusCode).toBe(422);

    const limited = await Promise.all(
      Array.from({ length: IMPORT_LIMIT.limit }, () => alice('POST', importPath('letterboxd'), { csv: 'a,b\n1,2' })),
    );
    const blocked = limited.find((res) => res.statusCode === 429);
    expect(blocked?.json().error).toMatch(/Trop d’imports/);
    expect(blocked?.headers['retry-after']).toBeDefined();
    expect((await bob('POST', importPath('letterboxd'), { csv: 'a,b\n1,2' })).statusCode).toBe(422);
  });

  it('TMDB en panne : l’import échoue (502), rien n’est écrit, il n’y a pas de faux « introuvable »', async () => {
    const { alice, data } = await setup({ tmdb: { 'GET /search/movie': status(500) } });
    const res = await alice('POST', importPath('letterboxd'), { csv });
    expect(res.statusCode).toBe(502);
    expect(data.db.select().from(watchlist).all()).toEqual([]);
  });
});

describe('réglage Trakt (propriétaire)', () => {
  it('réservé au propriétaire', async () => {
    const { alice } = await setup();
    expect((await alice('GET', TRAKT_SETTINGS_PATH)).statusCode).toBe(403);
    expect((await alice('PUT', TRAKT_SETTINGS_PATH, { clientId: CLIENT_ID })).statusCode).toBe(403);
  });

  it('enregistre le Client ID après l’avoir essayé, chiffré, sans jamais le renvoyer', async () => {
    const { proprio, data, traktServer } = await setup({ trakt: { 'GET /movies/trending': [] } });
    expect((await proprio('GET', TRAKT_SETTINGS_PATH)).json()).toEqual({ clientId: { set: false } });

    const saved = await proprio('PUT', TRAKT_SETTINGS_PATH, { clientId: CLIENT_ID });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ clientId: { set: true } });
    expect(JSON.stringify(saved.json())).not.toContain(CLIENT_ID);
    expect(traktServer.requests[0]?.headers['trakt-api-key']).toBe(CLIENT_ID);
    expect(data.db.$client.prepare("select value from settings where key = 'trakt'").get()).not.toMatchObject({
      value: expect.stringContaining(CLIENT_ID),
    });

    // champ vide : on garde le Client ID enregistré (et on le réessaie)
    expect((await proprio('PUT', TRAKT_SETTINGS_PATH, { clientId: '' })).json()).toEqual({ clientId: { set: true } });
    expect(traktServer.requests[1]?.headers['trakt-api-key']).toBe(CLIENT_ID);
  });

  it('un Client ID refusé par Trakt n’est pas enregistré (422)', async () => {
    const { proprio, data } = await setup({ trakt: { 'GET /movies/trending': status(403) } });
    const res = await proprio('PUT', TRAKT_SETTINGS_PATH, { clientId: 'mauvais' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Client ID Trakt refusé' });
    expect(data.db.$client.prepare("select count(*) as n from settings where key = 'trakt'").get()).toEqual({ n: 0 });
  });
});
