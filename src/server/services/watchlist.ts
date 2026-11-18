import { and, count, desc, eq } from 'drizzle-orm';
import type { MediaKey, MediaSummary, MediaType } from '../../shared/media.ts';
import { keyOf } from '../../shared/media.ts';
import { WATCHLIST_PAGE_SIZE, type WatchlistEntry, type WatchlistPage } from '../../shared/watchlist.ts';
import type { Db } from '../db/index.ts';
import { watchlist } from '../db/schema.ts';
import { IntegrationError } from '../integrations/http.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError } from '../lib/api-errors.ts';
import type { AvailabilityService } from './availability.ts';
import { loadSummaries } from './tmdb.ts';

type Row = typeof watchlist.$inferSelect;

const ownedBy = (userId: string, { type, tmdbId }: MediaKey) =>
  and(eq(watchlist.userId, userId), eq(watchlist.mediaType, type), eq(watchlist.tmdbId, tmdbId));

/** Titre d'une ligne de la liste, complété par TMDB quand la copie est incomplète (import Trakt : sans affiche). */
const asSummary = (row: Row, fresh: MediaSummary | undefined): MediaSummary =>
  fresh ?? {
    tmdbId: row.tmdbId,
    type: row.mediaType,
    title: row.title ?? '',
    year: row.year,
    posterPath: row.posterPath,
    backdropPath: null,
    overview: '',
  };

export function createWatchlist(db: Db, deps: { tmdb: () => TmdbClient; availability: AvailabilityService }) {
  /** Ajoute un titre à la liste du membre (idempotent) ; titre inconnu de TMDB → 404, et rien n'est écrit. */
  async function add(userId: string, type: MediaType, tmdbId: number): Promise<void> {
    let summary: MediaSummary;
    try {
      summary = await deps.tmdb().summary(type, tmdbId);
    } catch (err) {
      if (err instanceof IntegrationError && err.kind === 'not_found') throw new HttpError(404, 'Titre introuvable');
      throw err;
    }
    db.insert(watchlist)
      .values({
        userId,
        mediaType: type,
        tmdbId,
        title: summary.title,
        year: summary.year,
        posterPath: summary.posterPath,
        source: 'manual',
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Une page de « Ma liste », les plus récents d'abord, avec le statut de chaque titre. La copie enregistrée suffit
   * à l'affichage ; TMDB (en cache) ne complète que les titres dont la copie manque, et la copie est alors mise à jour.
   */
  async function list(userId: string, page: number): Promise<WatchlistPage> {
    const total = db.select({ n: count() }).from(watchlist).where(eq(watchlist.userId, userId)).get()?.n ?? 0;
    const rows = db
      .select()
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .orderBy(desc(watchlist.createdAt), desc(watchlist.id))
      .limit(WATCHLIST_PAGE_SIZE)
      .offset((page - 1) * WATCHLIST_PAGE_SIZE)
      .all();

    const incomplete = rows.filter((row) => row.title === null || row.posterPath === null);
    const fresh = await loadSummaries(
      deps.tmdb,
      incomplete.map((row) => ({ type: row.mediaType, tmdbId: row.tmdbId })),
    );
    for (const row of incomplete) {
      const summary = fresh.get(keyOf({ type: row.mediaType, tmdbId: row.tmdbId }));
      if (summary && (summary.title !== row.title || summary.posterPath !== row.posterPath))
        db.update(watchlist)
          .set({ title: summary.title, year: summary.year, posterPath: summary.posterPath })
          .where(eq(watchlist.id, row.id))
          .run();
    }

    const summaries = rows.map((row) => asSummary(row, fresh.get(keyOf({ type: row.mediaType, tmdbId: row.tmdbId }))));
    const withStatus = await deps.availability.withStatuses(summaries);
    const results: WatchlistEntry[] = withStatus.map((summary, i) => ({
      ...summary,
      source: (rows[i] as Row).source,
      addedAt: (rows[i] as Row).createdAt.toISOString(),
    }));
    return { page, totalPages: Math.ceil(total / WATCHLIST_PAGE_SIZE), total, results };
  }

  /** Le titre est-il dans la liste du membre. */
  const has = (userId: string, item: MediaKey): boolean =>
    db.select({ id: watchlist.id }).from(watchlist).where(ownedBy(userId, item)).get() !== undefined;

  /** Retire un titre de la liste du membre ; sans effet s'il n'y est pas. */
  function remove(userId: string, item: MediaKey): void {
    db.delete(watchlist).where(ownedBy(userId, item)).run();
  }

  return { add, list, has, remove };
}
