import { and, asc, avg, count, desc, eq, gte, inArray, isNotNull, max, sql } from 'drizzle-orm';
import { keyOf, type MediaType } from '../../shared/media.ts';
import { STATS_MONTHS, STATS_TOP, type Stats, type StatsDelay } from '../../shared/stats.ts';
import { emptyRequestCounts, type RequestEventType, type RequestStatus } from '../../shared/status.ts';
import type { Db } from '../db/index.ts';
import { issues, media, requestEvents, requests, users, watchlist } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { loadSummaries } from './tmdb.ts';
import { avatarUrlOf } from './users.ts';

// Toutes les dates sont en secondes Unix (colonnes `timestamp` de Drizzle) et les mois, en UTC.

type Reader = Pick<Db, 'select' | 'with' | '$with'>;

/** Premier jour (UTC) du plus ancien des 12 mois glissants : le mois courant et les 11 précédents. */
export const monthsWindowStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (STATS_MONTHS - 1), 1));

/** Libellés `AAAA-MM` des 12 mois glissants, du plus ancien au plus récent. */
export function windowMonths(now: Date): string[] {
  const start = monthsWindowStart(now);
  return Array.from({ length: STATS_MONTHS }, (_, i) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7),
  );
}

/** Demandes par mois : plage sur `created_at`, servie par l'index couvrant `requests_created_at_idx`. */
export const requestsByMonthQuery = (db: Pick<Db, 'select'>, since: Date) => {
  const month = sql<string>`strftime('%Y-%m', ${requests.createdAt}, 'unixepoch')`;
  return db.select({ month, n: count() }).from(requests).where(gte(requests.createdAt, since)).groupBy(month);
};

/** Demandes par statut, type de titre et qualité : un seul passage, il faut bien lire toutes les demandes. */
export const requestMixQuery = (db: Pick<Db, 'select'>) =>
  db
    .select({ status: requests.status, type: media.type, is4k: requests.is4k, n: count() })
    .from(requests)
    .innerJoin(media, eq(media.id, requests.mediaId))
    .groupBy(requests.status, media.type, requests.is4k);

/** Membres les plus actifs : `GROUP BY` servi par l'index couvrant `requests(user_id, created_at)`. */
export const topMembersQuery = (db: Pick<Db, 'select'>) =>
  db
    .select({ userId: requests.userId, n: count() })
    .from(requests)
    .groupBy(requests.userId)
    .orderBy(desc(count()), asc(requests.userId))
    .limit(STATS_TOP);

/** Titres les plus demandés : `GROUP BY` servi par l'index couvrant `requests(media_id, status)`. */
export const topTitlesQuery = (db: Pick<Db, 'select'>) =>
  db
    .select({ mediaId: requests.mediaId, n: count() })
    .from(requests)
    .groupBy(requests.mediaId)
    .orderBy(desc(count()), asc(requests.mediaId))
    .limit(STATS_TOP);

/** Signalements par statut (index `issues(status, created_at)`). */
export const issueTotalsQuery = (db: Pick<Db, 'select'>) =>
  db.select({ status: issues.status, n: count() }).from(issues).groupBy(issues.status);

/** Entrées des listes de souhaits, et titres distincts (aucun index ne commence par le titre : lecture de l'index unique). */
export const watchlistQuery = (db: Pick<Db, 'select'>) =>
  db
    .select({
      entries: count(),
      titles: sql<number>`count(distinct ${watchlist.mediaType} || ':' || ${watchlist.tmdbId})`,
    })
    .from(watchlist);

/** Demandes dont l'étape a eu lieu : approuvées ou au-delà (`approved`) ; arrivées dans Emby (`available`). */
const reached: Record<'approved' | 'available', readonly RequestStatus[]> = {
  approved: ['approved', 'sent', 'failed', 'available'],
  available: ['available'],
};

/**
 * Délai entre la demande et le premier évènement `event`, en secondes, avec sa médiane (rang central, moyenne des
 * deux au milieu d'un nombre pair) et sa moyenne. L'évènement est cherché par l'index `request_events(request_id,
 * created_at)`, pour les seules demandes du statut voulu (`requests(status, created_at)`).
 * Une approbation faite par le demandeur lui-même (rôle à approbation automatique) n'attend personne : elle est
 * écartée, comme les demandes importées de Seerr qui n'ont pas de frise.
 */
export const delayQuery = (db: Reader, event: keyof typeof reached) => {
  const happenedAt = sql<number>`(select min(${requestEvents.createdAt}) from ${requestEvents} where ${and(
    eq(requestEvents.requestId, requests.id),
    eq(requestEvents.type, event satisfies RequestEventType),
    event === 'approved' ? sql`${requestEvents.actorId} is not ${requests.userId}` : undefined,
  )})`;
  const delays = db.$with('delays').as(
    db
      .select({ secs: sql<number>`${happenedAt} - ${requests.createdAt}`.as('secs') })
      .from(requests)
      .where(inArray(requests.status, [...reached[event]])),
  );
  const ranked = db.$with('ranked').as(
    db
      .select({
        secs: delays.secs,
        rank: sql<number>`row_number() over (order by ${delays.secs})`.as('rank'),
        total: sql<number>`count(*) over ()`.as('total'),
      })
      .from(delays)
      .where(isNotNull(delays.secs)),
  );
  return db
    .with(delays, ranked)
    .select({
      samples: max(ranked.total),
      mean: avg(ranked.secs),
      median: sql<
        number | null
      >`avg(case when ${ranked.rank} in ((${ranked.total} + 1) / 2, (${ranked.total} + 2) / 2) then ${ranked.secs} end)`,
    })
    .from(ranked);
};

function delayOf(db: Reader, event: keyof typeof reached): StatsDelay {
  const row = delayQuery(db, event).get();
  const samples = Number(row?.samples ?? 0);
  if (samples === 0) return { samples: 0, medianSeconds: null, meanSeconds: null };
  return { samples, medianSeconds: Number(row?.median), meanSeconds: Number(row?.mean) };
}

/** Statistiques de la page « Statistiques » ; `now` est injecté pour des tests déterministes. */
export async function computeStats(db: Db, tmdb: () => TmdbClient, now: Date = new Date()): Promise<Stats> {
  const byStatus: Stats['requests']['byStatus'] = emptyRequestCounts();
  const byType: Stats['requests']['byType'] = { movie: 0, tv: 0 };
  const byQuality = { standard: 0, fourK: 0 };
  for (const { status, type, is4k, n } of requestMixQuery(db).all()) {
    byStatus[status] += n;
    byType[type] += n;
    byQuality[is4k ? 'fourK' : 'standard'] += n;
  }

  const monthCounts = new Map(
    requestsByMonthQuery(db, monthsWindowStart(now))
      .all()
      .map((r) => [r.month, r.n]),
  );
  const byMonth = windowMonths(now).map((month) => ({ month, count: monthCounts.get(month) ?? 0 }));

  const topUsers = topMembersQuery(db).all();
  const names = new Map(
    topUsers.length === 0
      ? []
      : db
          .select()
          .from(users)
          .where(
            inArray(
              users.id,
              topUsers.map((u) => u.userId),
            ),
          )
          .all()
          .map((u) => [u.id, u]),
  );
  const topMembers = topUsers.map(({ userId, n }) => {
    const user = names.get(userId);
    return { id: userId, name: user?.name ?? userId, avatarUrl: user ? avatarUrlOf(user) : null, count: n };
  });

  const topMedia = topTitlesQuery(db).all();
  const mediaRows = new Map(
    topMedia.length === 0
      ? []
      : db
          .select({ id: media.id, type: media.type, tmdbId: media.tmdbId })
          .from(media)
          .where(
            inArray(
              media.id,
              topMedia.map((m) => m.mediaId),
            ),
          )
          .all()
          .map((m) => [m.id, m]),
  );
  const keyed = topMedia.flatMap(({ mediaId, n }) => {
    const row = mediaRows.get(mediaId);
    return row ? [{ type: row.type as MediaType, tmdbId: row.tmdbId, n }] : [];
  });
  const summaries = await loadSummaries(tmdb, keyed);
  const topTitles = keyed.map(({ type, tmdbId, n }) => {
    const summary = summaries.get(keyOf({ type, tmdbId }));
    return {
      type,
      tmdbId,
      title: summary?.title ?? null,
      year: summary?.year ?? null,
      posterPath: summary?.posterPath ?? null,
      count: n,
    };
  });

  const issueCounts = { open: 0, resolved: 0 };
  for (const { status, n } of issueTotalsQuery(db).all()) issueCounts[status] = n;
  const wish = watchlistQuery(db).get();

  return {
    requests: {
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      byStatus,
      byMonth,
      byType,
      byQuality,
    },
    topMembers,
    topTitles,
    delays: { approval: delayOf(db, 'approved'), availability: delayOf(db, 'available') },
    issues: issueCounts,
    members: db.select({ n: count() }).from(users).get()?.n ?? 0,
    watchlist: { entries: wish?.entries ?? 0, titles: Number(wish?.titles ?? 0) },
  };
}
