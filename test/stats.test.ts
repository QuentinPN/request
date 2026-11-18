import { describe, expect, it } from 'vitest';
import { type Db, openDb } from '../src/server/db/index.ts';
import { issues, media, requestEvents, requests, watchlist } from '../src/server/db/schema.ts';
import type { TmdbClient } from '../src/server/integrations/tmdb.ts';
import {
  computeStats,
  delayQuery,
  issueTotalsQuery,
  requestMixQuery,
  requestsByMonthQuery,
  topMembersQuery,
  topTitlesQuery,
  windowMonths,
} from '../src/server/services/stats.ts';
import { upsertFromEmby } from '../src/server/services/users.ts';
import { STATS_PATH, STATS_TOP, statsSchema } from '../src/shared/stats.ts';
import { type RequestEventType, type RequestStatus, requestStatuses } from '../src/shared/status.ts';
import { loginAs, queryPlan, trackApps } from './helpers.ts';

const newApp = trackApps();

const NOW = new Date('2026-11-17T12:00:00Z');
const at = (iso: string) => new Date(iso);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const noTmdb = () => {
  throw new Error('TMDB non configuré');
};

/** TMDB qui ne connaît que « Matrix » (film 603) : les autres titres restent sans titre ni affiche. */
const knowsMatrix = (() => ({
  summary: async (type: string, tmdbId: number) => {
    if (type !== 'movie' || tmdbId !== 603) throw new Error('inconnu');
    return { type, tmdbId, title: 'Matrix', year: 1999, posterPath: '/matrix.jpg' };
  },
})) as unknown as () => TmdbClient;

function seedUsers(db: Db) {
  for (const id of ['alice', 'bob', 'carol', 'manager-1'])
    upsertFromEmby(db, { id, name: id[0]?.toUpperCase() + id.slice(1), avatar: null, isEmbyAdmin: false });
}

const addMedia = (db: Db, type: 'movie' | 'tv', tmdbId: number) =>
  db
    .insert(media)
    .values({ type, tmdbId, statusUpdatedAt: new Date(0) })
    .returning()
    .get().id;

function addRequest(
  db: Db,
  r: {
    mediaId: number;
    userId: string;
    status: RequestStatus;
    createdAt: string;
    is4k?: boolean;
    events?: Array<{ type: RequestEventType; actorId: string | null; after: number }>;
  },
) {
  const createdAt = at(r.createdAt);
  const { id } = db
    .insert(requests)
    .values({
      mediaId: r.mediaId,
      userId: r.userId,
      status: r.status,
      is4k: r.is4k ?? false,
      createdAt,
      updatedAt: createdAt,
    })
    .returning()
    .get();
  for (const e of r.events ?? [])
    db.insert(requestEvents)
      .values({ requestId: id, type: e.type, actorId: e.actorId, createdAt: new Date(createdAt.getTime() + e.after) })
      .run();
  return id;
}

/**
 * Jeu de données fixé (« maintenant » = 17/11/2026, fenêtre de décembre 2025 à novembre 2026) :
 * 7 demandes dont une hors fenêtre, un mois vide, une approbation automatique et une demande importée.
 */
function seedFixedDataset(db: Db) {
  seedUsers(db);
  const matrix = addMedia(db, 'movie', 603);
  const bb = addMedia(db, 'tv', 1396);
  const inception = addMedia(db, 'movie', 27205);
  const approved = (after: number) => ({ type: 'approved' as const, actorId: 'manager-1', after });
  const available = (after: number) => ({ type: 'available' as const, actorId: null, after });

  addRequest(db, {
    mediaId: matrix,
    userId: 'alice',
    status: 'available',
    createdAt: '2026-11-10T10:00:00Z',
    events: [approved(HOUR), available(3 * HOUR)],
  });
  addRequest(db, {
    mediaId: bb,
    userId: 'alice',
    status: 'sent',
    createdAt: '2026-11-12T10:00:00Z',
    events: [approved(3 * HOUR)],
  });
  addRequest(db, { mediaId: matrix, userId: 'bob', status: 'pending', createdAt: '2026-09-05T10:00:00Z' });
  addRequest(db, {
    mediaId: inception,
    userId: 'bob',
    status: 'declined',
    createdAt: '2026-09-20T10:00:00Z',
    is4k: true,
  });
  // Hors fenêtre (juin 2025) : compte dans les totaux, pas dans l'histogramme. Importée de Seerr : sans « approved ».
  addRequest(db, {
    mediaId: matrix,
    userId: 'alice',
    status: 'available',
    createdAt: '2025-06-01T10:00:00Z',
    events: [available(DAY)],
  });
  // Approbation automatique : le demandeur approuve sa propre demande, sans attente à mesurer.
  addRequest(db, {
    mediaId: inception,
    userId: 'carol',
    status: 'sent',
    createdAt: '2026-11-01T10:00:00Z',
    events: [{ type: 'approved', actorId: 'carol', after: 0 }],
  });
  addRequest(db, {
    mediaId: bb,
    userId: 'carol',
    status: 'available',
    createdAt: '2026-10-01T10:00:00Z',
    events: [available(7 * DAY)],
  });

  for (const status of ['open', 'open', 'resolved'] as const)
    db.insert(issues)
      .values({
        mediaId: matrix,
        userId: 'alice',
        type: 'video',
        message: 'Image saccadée',
        status,
        resolvedAt: status === 'resolved' ? NOW : null,
      })
      .run();
  db.insert(watchlist)
    .values([
      { userId: 'alice', mediaType: 'movie', tmdbId: 603 },
      { userId: 'alice', mediaType: 'tv', tmdbId: 1396 },
      { userId: 'bob', mediaType: 'movie', tmdbId: 603 },
    ])
    .run();
}

describe('GET /api/stats', () => {
  it('réservé aux gestionnaires et au propriétaire', async () => {
    const app = await newApp();
    for (const role of ['member', 'auto_approve'] as const) {
      const { headers } = await loginAs(app, role);
      expect((await app.inject({ method: 'GET', url: STATS_PATH, headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: STATS_PATH })).statusCode).toBe(401);
    for (const role of ['manager', 'owner'] as const) {
      const { headers } = await loginAs(app, role);
      expect((await app.inject({ method: 'GET', url: STATS_PATH, headers })).statusCode).toBe(200);
    }
  });

  it('base vide : tout à zéro, douze mois vides, classements vides, délais inconnus', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'manager');
    const res = await app.inject({ method: 'GET', url: STATS_PATH, headers });
    const stats = statsSchema.parse(res.json());
    expect(stats.requests.total).toBe(0);
    expect(stats.requests.byStatus).toEqual(Object.fromEntries(requestStatuses.map((s) => [s, 0])));
    expect(stats.requests.byMonth).toHaveLength(12);
    expect(stats.requests.byMonth.every((m) => m.count === 0)).toBe(true);
    expect(stats.requests.byType).toEqual({ movie: 0, tv: 0 });
    expect(stats.requests.byQuality).toEqual({ standard: 0, fourK: 0 });
    expect(stats.topMembers).toEqual([]);
    expect(stats.topTitles).toEqual([]);
    const unknown = { samples: 0, medianSeconds: null, meanSeconds: null };
    expect(stats.delays).toEqual({ approval: unknown, availability: unknown });
    expect(stats.issues).toEqual({ open: 0, resolved: 0 });
    expect(stats.members).toBe(1); // le gestionnaire connecté
    expect(stats.watchlist).toEqual({ entries: 0, titles: 0 });
  });

  it('chiffre les demandes réelles, conformes au contrat partagé', async () => {
    const app = await newApp();
    const { headers } = await loginAs(app, 'owner');
    seedFixedDataset(app.data.db);
    const res = await app.inject({ method: 'GET', url: STATS_PATH, headers });
    const stats = statsSchema.parse(res.json());
    expect(stats.requests.total).toBe(7);
    // TMDB non configuré dans ce test : les titres restent connus par leur seul identifiant.
    expect(stats.topTitles[0]).toMatchObject({ type: 'movie', tmdbId: 603, title: null, posterPath: null, count: 3 });
  });
});

describe('statistiques sur un jeu de données fixé', () => {
  const stats = async (tmdb: () => TmdbClient = noTmdb) => {
    const db = openDb(':memory:');
    seedFixedDataset(db);
    return { db, stats: await computeStats(db, tmdb, NOW) };
  };

  it('demandes par statut, type et qualité', async () => {
    const { stats: s } = await stats();
    expect(s.requests.total).toBe(7);
    expect(s.requests.byStatus).toEqual({
      pending: 1,
      approved: 0,
      declined: 1,
      cancelled: 0,
      sent: 2,
      failed: 0,
      available: 3,
    });
    expect(s.requests.byType).toEqual({ movie: 5, tv: 2 });
    expect(s.requests.byQuality).toEqual({ standard: 6, fourK: 1 });
  });

  it('douze mois glissants, mois vides compris, sans la demande hors fenêtre', async () => {
    const { stats: s } = await stats();
    expect(s.requests.byMonth.map((m) => m.month)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(s.requests.byMonth.map((m) => m.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 3]);
  });

  it('la fenêtre suit le mois courant, y compris au passage d’année', () => {
    expect(windowMonths(new Date('2026-01-31T23:59:59Z'))[0]).toBe('2025-02');
    expect(windowMonths(new Date('2026-01-31T23:59:59Z')).at(-1)).toBe('2026-01');
    expect(windowMonths(new Date('2026-12-01T00:00:00Z'))[0]).toBe('2026-01');
  });

  it('membres et titres les plus demandés, à égalité par identifiant', async () => {
    const { stats: s } = await stats(knowsMatrix);
    expect(s.topMembers).toEqual([
      { id: 'alice', name: 'Alice', avatarUrl: null, count: 3 },
      { id: 'bob', name: 'Bob', avatarUrl: null, count: 2 },
      { id: 'carol', name: 'Carol', avatarUrl: null, count: 2 },
    ]);
    expect(s.topTitles).toEqual([
      { type: 'movie', tmdbId: 603, title: 'Matrix', year: 1999, posterPath: '/matrix.jpg', count: 3 },
      { type: 'tv', tmdbId: 1396, title: null, year: null, posterPath: null, count: 2 },
      { type: 'movie', tmdbId: 27205, title: null, year: null, posterPath: null, count: 2 },
    ]);
  });

  it('délais : médiane et moyenne, sans l’approbation automatique ni les demandes sans frise', async () => {
    const { stats: s } = await stats();
    // Approbation : 1 h et 3 h (carol s'approuve elle-même, la demande importée n'a pas d'évènement).
    expect(s.delays.approval).toEqual({ samples: 2, medianSeconds: 2 * 3600, meanSeconds: 2 * 3600 });
    // Disponibilité : 3 h, 1 jour et 7 jours.
    expect(s.delays.availability).toEqual({
      samples: 3,
      medianSeconds: 86400,
      meanSeconds: (3 * 3600 + 86400 + 7 * 86400) / 3,
    });
  });

  it('signalements, membres et listes de souhaits', async () => {
    const { stats: s } = await stats();
    expect(s.issues).toEqual({ open: 2, resolved: 1 });
    expect(s.members).toBe(4);
    expect(s.watchlist).toEqual({ entries: 3, titles: 2 });
  });

  it('classements limités à dix lignes', async () => {
    const db = openDb(':memory:');
    seedUsers(db);
    for (let i = 0; i < STATS_TOP + 3; i++)
      addRequest(db, {
        mediaId: addMedia(db, 'movie', 1000 + i),
        userId: 'alice',
        status: 'pending',
        createdAt: '2026-11-01T10:00:00Z',
      });
    const s = await computeStats(db, noTmdb, NOW);
    expect(s.topTitles).toHaveLength(STATS_TOP);
  });
});

describe('plans d’exécution', () => {
  const db = openDb(':memory:');
  seedFixedDataset(db);

  it('les mois : plage sur l’index couvrant de created_at', () => {
    expect(queryPlan(db, requestsByMonthQuery(db, new Date(0)))).toMatch(
      /SEARCH requests USING COVERING INDEX requests_created_at_idx \(created_at>\?\)/,
    );
  });

  it('les classements : GROUP BY lu dans un index couvrant, sans lecture de la table', () => {
    const members = queryPlan(db, topMembersQuery(db));
    expect(members).toContain('COVERING INDEX requests_user_id_created_at_idx');
    expect(members).not.toMatch(/SCAN requests(?! USING)/);
    const titles = queryPlan(db, topTitlesQuery(db));
    expect(titles).toContain('COVERING INDEX requests_media_id_status_idx');
    expect(titles).not.toMatch(/SCAN requests(?! USING)/);
  });

  it('les signalements : index (status, created_at)', () => {
    expect(queryPlan(db, issueTotalsQuery(db))).toContain('COVERING INDEX issues_status_created_at_idx');
  });

  it('la répartition : un seul passage sur les demandes, titres lus par clé primaire', () => {
    const plan = queryPlan(db, requestMixQuery(db));
    expect(plan).not.toMatch(/SCAN media(?! USING)/);
    expect(plan).toMatch(/SEARCH media USING INTEGER PRIMARY KEY|SCAN media USING/);
  });

  it('les délais : demandes par statut, évènement cherché par demande, jamais balayé en entier', () => {
    for (const event of ['approved', 'available'] as const) {
      const plan = queryPlan(db, delayQuery(db, event));
      expect(plan).toContain('requests_status_created_at_idx');
      expect(plan).toContain('request_events_request_id_created_at_idx');
      expect(plan).not.toMatch(/SCAN (request_events|requests)(?! USING)/);
    }
  });
});
