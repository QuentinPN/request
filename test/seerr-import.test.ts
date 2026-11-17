import { asc, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/index.ts';
import { media, notifications, requestEvents, requestSeasons, requests, settings } from '../src/server/db/schema.ts';
import { markAvailable } from '../src/server/services/requests.ts';
import { IMPORTED_DETAIL } from '../src/server/services/seerr-import.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { upsertFromEmby } from '../src/server/services/users.ts';
import { SEERR_IMPORT_PATH, type SeerrImportResult } from '../src/shared/import.ts';
import { closedPortUrl, type FakeHandler, status } from './fake-server.ts';
import seerrFixture from './fixtures/seerr/request-emby-tv.json';
import { loginAs, loginAsOwner, trackApps, trackFakeServers } from './helpers.ts';

const newApp = trackApps();
const serve = trackFakeServers();

const SEERR_KEY = 'CLE-SEERR-TRES-SECRETE-0123456789';

// --- Comptes et demandes Seerr ---

/** Compte Emby dans Jellyseerr : id Emby au format GUID, en majuscules (le membre local l'a sans tirets). */
const alice = { id: 1, jellyfinUserId: 'A1B2C3D4-E5F6', jellyfinUsername: 'alice-emby', displayName: 'Alice' };
/** Compte local de Seerr : seul le nom permet de le retrouver (casse différente). */
const bob = { id: 2, username: 'BOB', displayName: 'BOB', email: 'bob@exemple.fr' };
const stranger = { id: 3, jellyfinUserId: 'zzz', displayName: 'Inconnu' };

let nextId = 1;
type Seerr = Record<string, unknown>;
function seerrRequest({
  status: requestStatus = 1,
  type = 'movie',
  tmdbId = 603,
  mediaStatus = 3,
  status4k = 1,
  seasons = [] as number[],
  is4k = false,
  user = alice as Seerr,
  createdAt = '2025-03-14T10:00:00.000Z',
  ...extra
}: Record<string, unknown> = {}): Seerr {
  return {
    id: nextId++,
    status: requestStatus,
    type,
    is4k,
    createdAt,
    updatedAt: '2025-03-15T10:00:00.000Z',
    media: { id: 9, mediaType: type, tmdbId, tvdbId: type === 'tv' ? 81189 : null, status: mediaStatus, status4k },
    seasons: (seasons as number[]).map((seasonNumber, i) => ({ id: i + 1, seasonNumber, status: 2 })),
    requestedBy: user,
    profileName: 'HD',
    ...extra,
  };
}

/** Faux Seerr : pagination `take`/`skip` sur `items`, clé exigée dans `X-Api-Key`. */
const seerrRoute =
  (items: Seerr[]): FakeHandler =>
  (req, res) => {
    if (req.headers['x-api-key'] !== SEERR_KEY) return status(401, { message: 'Unauthorized' })(req, res);
    const take = Number(req.query.take);
    const skip = Number(req.query.skip);
    return status(200, {
      pageInfo: { pages: Math.ceil(items.length / take), pageSize: take, results: items.length, page: skip / take + 1 },
      results: items.slice(skip, skip + take),
      serviceErrors: { radarr: [], sonarr: [] },
    })(req, res);
  };

// --- Appli ---

async function setup(items: Seerr[]) {
  const app = await newApp();
  const { db, cryptoKey } = app.data;
  const owner = await loginAsOwner(app);
  upsertFromEmby(db, { id: 'a1b2c3d4e5f6', name: 'Alice', avatar: null, isEmbyAdmin: false });
  upsertFromEmby(db, { id: 'emby-bob', name: 'Bob', avatar: null, isEmbyAdmin: false });
  const seerr = await serve({ 'GET /api/v1/request': seerrRoute(items) });
  // Radarr et Sonarr configurés : l'import ne doit jamais les appeler.
  const arr = await serve({});
  setSetting(db, cryptoKey, 'radarr', { url: arr.url, apiKey: 'k', qualityProfileId: 1, rootFolderPath: '/films' });
  setSetting(db, cryptoKey, 'sonarr', { url: arr.url, apiKey: 'k', qualityProfileId: 2, rootFolderPath: '/series' });
  const run = (dryRun = false, body: object = { url: seerr.url, apiKey: SEERR_KEY }, headers = owner.headers) =>
    app.inject({ method: 'POST', url: `${SEERR_IMPORT_PATH}${dryRun ? '?dryRun=1' : ''}`, headers, payload: body });
  return { app, db, owner, seerr, arr, run };
}

const rowsOf = (db: Db) =>
  db
    .select({
      id: requests.id,
      status: requests.status,
      userId: requests.userId,
      tmdbId: media.tmdbId,
      is4k: requests.is4k,
      externalRef: requests.externalRef,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .innerJoin(media, eq(media.id, requests.mediaId))
    .orderBy(asc(requests.id))
    .all();

const countOf = (db: Db, table: typeof requests | typeof requestEvents | typeof notifications | typeof media) =>
  db.select({ n: count() }).from(table).get()?.n ?? 0;

const resultOf = (res: { json: () => unknown }) => res.json() as SeerrImportResult;

describe('POST /api/import/seerr', () => {
  it('reprend chaque statut, la date d’origine et un seul évènement, sans quota, notification ni Radarr/Sonarr', async () => {
    const items = [
      seerrRequest({ status: 1, tmdbId: 1 }), // en attente
      seerrRequest({ status: 2, tmdbId: 2, mediaStatus: 3 }), // approuvée, en cours → envoyée
      seerrRequest({ status: 2, tmdbId: 3, mediaStatus: 5 }), // approuvée, disponible
      seerrRequest({ status: 3, tmdbId: 4 }), // refusée
      seerrRequest({ status: 4, tmdbId: 5 }), // échec d'envoi dans Seerr
      seerrRequest({ status: 5, tmdbId: 6 }), // terminée
      seerrRequest({ status: 2, tmdbId: 2, is4k: true, mediaStatus: 3, status4k: 5 }), // 4K disponible
      seerrRequest({ status: 1, type: 'tv', tmdbId: 1396, seasons: [2, 1, 1], user: bob }),
      seerrRequest({ status: 9, tmdbId: 7 }), // statut inconnu
      seerrRequest({ media: null }), // titre supprimé de Seerr
      seerrRequest({ status: 1, type: 'tv', tmdbId: 1399, seasons: [] }), // série sans saison
      { id: 'illisible' },
    ];
    const { db, run, arr } = await setup(items);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(resultOf(res)).toEqual({
      dryRun: false,
      total: 12,
      imported: 8,
      alreadyPresent: 0,
      unmatchedUsers: [],
      unmatchedMedia: 4,
      skipped4k: 0,
    });
    const rows = rowsOf(db);
    expect(rows.map((r) => [r.tmdbId, r.status, r.is4k])).toEqual([
      [1, 'pending', false],
      [2, 'sent', false],
      [3, 'available', false],
      [4, 'declined', false],
      [5, 'failed', false],
      [6, 'available', false],
      [2, 'available', true],
      [1396, 'pending', false],
    ]);
    expect(rows[0]).toMatchObject({
      userId: 'a1b2c3d4e5f6',
      externalRef: `seerr:${items[0]?.id}`,
      createdAt: new Date('2025-03-14T10:00:00.000Z'),
    });
    expect(rows[7]?.userId).toBe('emby-bob');
    const tv = rows[7]?.id ?? 0;
    const seasons = db.select().from(requestSeasons).where(eq(requestSeasons.requestId, tv)).all();
    expect(seasons.map((s) => s.seasonNumber).sort()).toEqual([1, 2]);
    const events = db.select().from(requestEvents).all();
    expect(events).toHaveLength(8);
    expect(events.every((e) => e.type === 'requested' && e.detail === IMPORTED_DETAIL)).toBe(true);
    expect(events[0]?.createdAt).toEqual(new Date('2025-03-14T10:00:00.000Z'));
    expect(countOf(db, notifications)).toBe(0);
    expect(arr.requests).toHaveLength(0);
  });

  it('lit toutes les pages et écrit par lots', async () => {
    const items = Array.from({ length: 230 }, (_, i) => seerrRequest({ tmdbId: 1000 + i }));
    const { db, run, seerr } = await setup(items);
    expect(resultOf(await run()).imported).toBe(230);
    expect(seerr.requests.map((r) => [r.query.skip, r.query.take, r.query.filter])).toEqual([
      ['0', '100', 'all'],
      ['100', '100', 'all'],
      ['200', '100', 'all'],
    ]);
    expect(countOf(db, requests)).toBe(230);
  });

  it('lit une demande au format réel de Seerr 3.5.2 (compte Emby : `userType` 4, id Emby dans `jellyfinUserId`)', async () => {
    const { db, run } = await setup([seerrFixture]);
    // Même id que celui renvoyé par Emby (`User.Id`), nom différent : la correspondance se fait par l'id.
    upsertFromEmby(db, {
      id: 'f1e2d3c4b5a697887766554433221100',
      name: 'Alice (salon)',
      avatar: null,
      isEmbyAdmin: false,
    });
    expect(resultOf(await run())).toMatchObject({ imported: 1, unmatchedUsers: [], unmatchedMedia: 0 });
    expect(rowsOf(db)).toEqual([
      {
        id: expect.any(Number),
        status: 'sent',
        userId: 'f1e2d3c4b5a697887766554433221100',
        tmdbId: 1396,
        is4k: false,
        externalRef: 'seerr:42',
        createdAt: new Date('2026-10-01T18:30:12.000Z'),
      },
    ]);
    const seasons = db.select().from(requestSeasons).all();
    expect(seasons.map((s) => s.seasonNumber).sort()).toEqual([1, 2]);
  });

  it('retrouve les membres par id Emby puis par nom, et signale les autres sans rien créer', async () => {
    const homonym = { id: 4, username: 'Camille' };
    const items = [
      seerrRequest({ tmdbId: 1, user: { ...alice, jellyfinUsername: 'autre-nom', displayName: 'Autre' } }),
      seerrRequest({ tmdbId: 2, user: bob }),
      seerrRequest({ tmdbId: 3, user: stranger }),
      seerrRequest({ tmdbId: 4, user: stranger }),
      seerrRequest({ tmdbId: 5, user: homonym }),
      seerrRequest({ tmdbId: 6, user: null }),
    ];
    const { app, db, run } = await setup(items);
    // Deux membres du même nom : le nom ne suffit plus.
    upsertFromEmby(app.data.db, { id: 'camille-1', name: 'Camille', avatar: null, isEmbyAdmin: false });
    upsertFromEmby(app.data.db, { id: 'camille-2', name: 'camille', avatar: null, isEmbyAdmin: false });
    const usersBefore = db.$client.prepare('select count(*) as n from users').get() as { n: number };

    const result = resultOf(await run());
    expect(result.imported).toBe(2);
    expect(result.unmatchedUsers).toEqual([
      { seerrId: 3, name: 'Inconnu', requests: 2 },
      { seerrId: 4, name: 'Camille', requests: 1 },
      { seerrId: 0, name: 'Compte Seerr inconnu', requests: 1 },
    ]);
    expect(rowsOf(db).map((r) => r.userId)).toEqual(['a1b2c3d4e5f6', 'emby-bob']);
    expect(db.$client.prepare('select count(*) as n from users').get()).toEqual(usersBefore);
  });

  it('relancé, ne crée aucun doublon ; une demande en cours du même membre est reprise', async () => {
    const items = [
      seerrRequest({ status: 2, tmdbId: 1 }),
      seerrRequest({ status: 3, tmdbId: 2 }),
      seerrRequest({ status: 5, tmdbId: 3 }),
      // Deux demandes en attente de la même série : une seule demande, toutes ses saisons.
      seerrRequest({ status: 1, type: 'tv', tmdbId: 1396, seasons: [1] }),
      seerrRequest({ status: 1, type: 'tv', tmdbId: 1396, seasons: [2] }),
      // Déjà demandé dans l'appli par le même membre.
      seerrRequest({ status: 1, tmdbId: 603 }),
    ];
    const { db, run } = await setup(items);
    const mediaId = db
      .insert(media)
      .values({ type: 'movie', tmdbId: 603, statusUpdatedAt: new Date(0) })
      .returning()
      .get().id;
    db.insert(requests).values({ mediaId, userId: 'a1b2c3d4e5f6', status: 'pending' }).run();

    const first = resultOf(await run());
    expect(first).toMatchObject({ imported: 4, alreadyPresent: 2 });
    const tv = rowsOf(db).find((r) => r.tmdbId === 1396);
    const seasons = db
      .select()
      .from(requestSeasons)
      .where(eq(requestSeasons.requestId, tv?.id ?? 0))
      .all();
    expect(seasons.map((s) => s.seasonNumber).sort()).toEqual([1, 2]);
    const snapshot = { requests: countOf(db, requests), events: countOf(db, requestEvents) };

    const second = resultOf(await run());
    expect(second).toMatchObject({ imported: 0, alreadyPresent: 6 });
    expect({ requests: countOf(db, requests), events: countOf(db, requestEvents) }).toEqual(snapshot);
  });

  it('l’aperçu n’écrit rien et annonce les mêmes comptes que l’import', async () => {
    const items = [
      seerrRequest({ status: 1, tmdbId: 1 }),
      seerrRequest({ status: 1, tmdbId: 1 }), // doublon dans Seerr même : déjà là au second passage
      seerrRequest({ status: 2, type: 'tv', tmdbId: 1396, seasons: [1, 2] }),
      seerrRequest({ tmdbId: 3, user: stranger }),
      seerrRequest({ media: null }),
    ];
    const { db, run } = await setup(items);
    const preview = resultOf(await run(true));
    expect(preview).toEqual({
      dryRun: true,
      total: 5,
      imported: 2,
      alreadyPresent: 1,
      unmatchedUsers: [{ seerrId: 3, name: 'Inconnu', requests: 1 }],
      unmatchedMedia: 1,
      skipped4k: 0,
    });
    expect([countOf(db, requests), countOf(db, requestEvents), countOf(db, media)]).toEqual([0, 0, 0]);
    expect({ ...resultOf(await run()), dryRun: true }).toEqual(preview);
  });

  it('réservé au propriétaire : Seerr n’est même pas appelé', async () => {
    const { app, run, seerr } = await setup([seerrRequest()]);
    for (const role of ['manager', 'member'] as const) {
      const { headers } = await loginAs(app, role);
      expect((await run(false, undefined, headers)).statusCode).toBe(403);
    }
    expect(seerr.requests).toHaveLength(0);
  });

  it('la clé n’est jamais renvoyée ni enregistrée, même en erreur', async () => {
    const { db, run, seerr } = await setup([seerrRequest()]);
    const ok = await run(true);
    expect(ok.body).not.toContain(SEERR_KEY);
    expect(seerr.requests[0]?.headers['x-api-key']).toBe(SEERR_KEY);
    expect(seerr.requests[0]?.query).not.toHaveProperty('apiKey');

    const refused = await run(false, { url: seerr.url, apiKey: `${SEERR_KEY}-faux` });
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "Clé d'API refusée par Seerr" });
    expect(refused.body).not.toContain(SEERR_KEY);

    const unreachable = await run(false, { url: await closedPortUrl(), apiKey: SEERR_KEY });
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.body).not.toContain(SEERR_KEY);

    expect((await run(false, { url: 'pas-une-adresse', apiKey: SEERR_KEY })).statusCode).toBe(400);
    expect(JSON.stringify(db.select().from(settings).all())).not.toContain(SEERR_KEY);
    expect(countOf(db, requests)).toBe(0);
  });
});

describe('demande 4K importée', () => {
  it('en attente ou en échec : écartée et comptée, l’historique reste importé', async () => {
    const { db, run } = await setup([
      seerrRequest({ status: 1, tmdbId: 1, is4k: true }),
      seerrRequest({ status: 4, tmdbId: 2, is4k: true }),
      seerrRequest({ status: 3, tmdbId: 3, is4k: true }),
      seerrRequest({ status: 1, tmdbId: 1 }),
    ]);
    const res = resultOf(await run());
    expect(res).toMatchObject({ imported: 2, skipped4k: 2 });
    expect(rowsOf(db).map((r) => [r.tmdbId, r.status, r.is4k])).toEqual([
      [3, 'declined', true],
      [1, 'pending', false],
    ]);
  });

  it('ne passe pas « disponible » avec la version ordinaire du titre', async () => {
    const { db, run } = await setup([seerrRequest({ status: 2, tmdbId: 2, is4k: true, status4k: 3 })]);
    await run();
    const [row] = rowsOf(db);
    expect(row).toMatchObject({ status: 'sent', is4k: true });
    const mediaId = db.select().from(media).get()?.id ?? 0;
    db.update(media).set({ status: 'available' }).where(eq(media.id, mediaId)).run();
    expect(markAvailable(db, [mediaId], new Date())).toEqual([]);
  });
});
