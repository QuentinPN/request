import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ISSUES_PAGE_SIZE,
  type IssueComment,
  type IssueDetail,
  type IssuePage,
  type IssueView,
  type issueCommentInputSchema,
  type issueCreateSchema,
  type issueListQuerySchema,
} from '../../shared/issues.ts';
import { keyOf } from '../../shared/media.ts';
import type { LibraryStatus } from '../../shared/status.ts';
import type { Data, Db } from '../db/index.ts';
import { issueComments, issues, media, seasons, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError } from '../lib/api-errors.ts';
import type { SessionViewer } from '../plugins/auth.ts';
import { type AvailabilityService, selectCached } from './availability.ts';
import { mediaServerName } from './media-server.ts';
import { notifyIssueEvent } from './notifications.ts';
import { toPerson } from './requests.ts';
import { loadSummaries } from './tmdb.ts';

type CreateInput = z.output<typeof issueCreateSchema>;
type CommentInput = z.output<typeof issueCommentInputSchema>;
type ListQuery = z.output<typeof issueListQuerySchema>;

const NOT_FOUND = 'Signalement introuvable';
/** Seule une copie présente dans la bibliothèque peut avoir un problème (le statut affiché, lui, suit les demandes). */
const REPORTABLE: readonly LibraryStatus[] = ['available', 'partial'];

/** `col = valeur`, ou `col IS NULL` : en SQL, `= NULL` ne correspond jamais. */
const eqOrNull = (col: Parameters<typeof eq>[0], value: number | null) =>
  value === null ? isNull(col) : eq(col, value);

const selectRows = (db: Pick<Db, 'select'>) =>
  db
    .select({ ...getTableColumns(issues), mediaType: media.type, tmdbId: media.tmdbId })
    .from(issues)
    .innerJoin(media, eq(media.id, issues.mediaId));
type Row = ReturnType<ReturnType<typeof selectRows>['all']>[number];

/**
 * Signalements de problèmes : un membre voit et commente les siens, le droit « gérer les signalements » voit tout.
 * Toute transition est un `UPDATE … WHERE status = <attendu>` (deux gestionnaires simultanés : le second reçoit 409).
 * Les notifications sont écrites dans la transaction de l'évènement (`notifyIssueEvent`).
 */
export function createIssues(
  data: Data,
  deps: { tmdb: () => TmdbClient; availability: AvailabilityService; now?: () => number },
) {
  const { db } = data;
  const now = deps.now ?? Date.now;

  /** Périmètre du membre : tous les signalements pour un gestionnaire, les siens sinon. */
  const scopeOf = ({ user, capabilities }: SessionViewer): SQL | undefined =>
    capabilities.canManageIssues ? undefined : eq(issues.userId, user.id);

  // --- Lecture ---

  function requireRow(id: number, viewer: SessionViewer): Row {
    const row = selectRows(db)
      .where(and(eq(issues.id, id), scopeOf(viewer)))
      .get();
    if (!row) throw new HttpError(404, NOT_FOUND);
    return row;
  }

  /** Vues d'une page : membres et résumés lus par lot. */
  async function toViews(rows: Row[]): Promise<IssueView[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.flatMap((r) => (r.resolvedBy ? [r.userId, r.resolvedBy] : [r.userId])))];
    const people = new Map(
      db
        .select()
        .from(users)
        .where(inArray(users.id, ids))
        .all()
        .map((u) => [u.id, toPerson(u)]),
    );
    const titles = await loadSummaries(
      deps.tmdb,
      rows.map((r) => ({ type: r.mediaType, tmdbId: r.tmdbId })),
    );
    return rows.map((r) => {
      const summary = titles.get(keyOf({ type: r.mediaType, tmdbId: r.tmdbId }));
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        media: { type: r.mediaType, tmdbId: r.tmdbId },
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episodeNumber,
        message: r.message,
        author: people.get(r.userId) ?? null,
        resolvedBy: r.resolvedBy ? (people.get(r.resolvedBy) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        title: summary?.title ?? null,
        posterPath: summary?.posterPath ?? null,
      };
    });
  }

  /** Signalement et son fil, dans l'ordre d'écriture (même seconde : ordre d'insertion). */
  async function detailOf(row: Row): Promise<IssueDetail> {
    const [view] = await toViews([row]);
    const thread = db
      .select({ comment: issueComments, author: users })
      .from(issueComments)
      .leftJoin(users, eq(users.id, issueComments.userId))
      .where(eq(issueComments.issueId, row.id))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
      .all();
    const comments: IssueComment[] = thread.map(({ comment, author }) => ({
      id: comment.id,
      issueId: comment.issueId,
      author: author ? toPerson(author) : null,
      message: comment.message,
      createdAt: comment.createdAt.toISOString(),
    }));
    return { ...(view as IssueView), comments };
  }

  const countByStatus = (viewer: SessionViewer) => {
    const totals = { open: 0, resolved: 0 };
    for (const { status, n } of db
      .select({ status: issues.status, n: count() })
      .from(issues)
      .where(scopeOf(viewer))
      .groupBy(issues.status)
      .all())
      totals[status] = n;
    return totals;
  };

  async function list(viewer: SessionViewer, query: ListQuery): Promise<IssuePage> {
    const totals = countByStatus(viewer);
    const total = query.status ? totals[query.status] : totals.open + totals.resolved;
    const rows = selectRows(db)
      .where(and(scopeOf(viewer), query.status && eq(issues.status, query.status)))
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(ISSUES_PAGE_SIZE)
      .offset((query.page - 1) * ISSUES_PAGE_SIZE)
      .all();
    return {
      page: query.page,
      totalPages: Math.ceil(total / ISSUES_PAGE_SIZE),
      results: await toViews(rows),
      totals,
    };
  }

  const counts = (viewer: SessionViewer) => ({ open: countByStatus(viewer).open });

  async function get(viewer: SessionViewer, id: number): Promise<IssueDetail> {
    return detailOf(requireRow(id, viewer));
  }

  // --- Écriture ---

  /**
   * Signale un problème sur un titre présent dans la bibliothèque. Le statut de bibliothèque (rafraîchi s'il est
   * périmé) décide, pas le statut affiché : une série partielle dont des saisons sont demandées reste signalable.
   */
  async function create(viewer: SessionViewer, input: CreateInput): Promise<IssueDetail> {
    const key = { type: input.mediaType, tmdbId: input.tmdbId };
    await deps.availability.statusesFor([key]);
    const cached = selectCached(db, [key]).get();
    if (!cached?.status || !REPORTABLE.includes(cached.status as LibraryStatus))
      throw new HttpError(
        409,
        `Seul un titre disponible dans ${mediaServerName(data)} peut faire l’objet d’un signalement`,
      );
    const mediaId = cached.id;
    if (input.seasonNumber !== null) {
      // Saisons connues localement : si on en a, la saison signalée doit en faire partie.
      const known = db.select({ n: seasons.seasonNumber }).from(seasons).where(eq(seasons.mediaId, mediaId)).all();
      if (known.length > 0 && !known.some((s) => s.n === input.seasonNumber))
        throw new HttpError(400, `La saison ${input.seasonNumber} n’existe pas pour ce titre`);
    }
    const id = db.transaction((tx) => {
      // Double clic ou requête rejouée : le même signalement encore ouvert du même membre n'est pas recréé.
      const duplicate = tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.mediaId, mediaId),
            eq(issues.userId, viewer.user.id),
            eq(issues.status, 'open'),
            eq(issues.type, input.type),
            eqOrNull(issues.seasonNumber, input.seasonNumber),
            eqOrNull(issues.episodeNumber, input.episodeNumber),
          ),
        )
        .get();
      if (duplicate) throw new HttpError(409, 'Vous avez déjà un signalement ouvert identique sur ce titre');
      const at = new Date(now());
      const created = tx
        .insert(issues)
        .values({
          mediaId,
          userId: viewer.user.id,
          type: input.type,
          seasonNumber: input.seasonNumber,
          episodeNumber: input.episodeNumber,
          message: input.message,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: issues.id })
        .get();
      notifyIssueEvent(tx, { issueId: created.id, kind: 'issue_created', actorId: viewer.user.id, at });
      return created.id;
    });
    return detailOf(requireRow(id, viewer));
  }

  async function comment(viewer: SessionViewer, id: number, input: CommentInput): Promise<IssueDetail> {
    requireRow(id, viewer);
    db.transaction((tx) => {
      const at = new Date(now());
      tx.insert(issueComments)
        .values({ issueId: id, userId: viewer.user.id, message: input.message, createdAt: at })
        .run();
      tx.update(issues).set({ updatedAt: at }).where(eq(issues.id, id)).run();
      notifyIssueEvent(tx, { issueId: id, kind: 'issue_commented', actorId: viewer.user.id, at });
    });
    return detailOf(requireRow(id, viewer));
  }

  /** `open → resolved` (`resolving`) ou `resolved → open` ; rien de modifié → 409 (déjà fait entre-temps). */
  async function transition(viewer: SessionViewer, id: number, resolving: boolean): Promise<IssueDetail> {
    requireRow(id, viewer);
    // L'auteur résout le sien, un gestionnaire n'importe lequel ; rouvrir est réservé aux gestionnaires.
    if (!resolving && !viewer.capabilities.canManageIssues)
      throw new HttpError(403, 'Seul un gestionnaire peut rouvrir un signalement');
    db.transaction((tx) => {
      const at = new Date(now());
      const updated = tx
        .update(issues)
        .set(
          resolving
            ? { status: 'resolved', resolvedBy: viewer.user.id, resolvedAt: at, updatedAt: at }
            : { status: 'open', resolvedBy: null, resolvedAt: null, updatedAt: at },
        )
        .where(and(eq(issues.id, id), eq(issues.status, resolving ? 'open' : 'resolved')))
        .returning({ id: issues.id })
        .get();
      if (!updated)
        throw new HttpError(409, resolving ? 'Ce signalement est déjà résolu' : 'Ce signalement est déjà ouvert');
      notifyIssueEvent(tx, {
        issueId: id,
        kind: resolving ? 'issue_resolved' : 'issue_reopened',
        actorId: viewer.user.id,
        at,
      });
    });
    return detailOf(requireRow(id, viewer));
  }

  const resolve = (viewer: SessionViewer, id: number) => transition(viewer, id, true);
  const reopen = (viewer: SessionViewer, id: number) => transition(viewer, id, false);

  return { create, list, counts, get, comment, resolve, reopen };
}
