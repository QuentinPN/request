import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  gte,
  inArray,
  max,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import { keyOf, type MediaDetails, type MediaType } from '../../shared/media.ts';
import {
  type ApproveRequestInput,
  type BatchResult,
  type batchRequestSchema,
  type createRequestSchema,
  isAiredSeason,
  isoDay,
  REQUESTS_PAGE_SIZE,
  type RequestCounts,
  type RequestDetail,
  type RequestPage,
  type RequestPerson,
  type RequestQuota,
  type RequestView,
  type requestListQuerySchema,
} from '../../shared/requests.ts';
import type { QuotaRule } from '../../shared/roles.ts';
import { settingSchemas } from '../../shared/settings.ts';
import {
  activeRequestStatuses,
  preSendRequestStatuses,
  type RequestEventType,
  type RequestStatus,
  requestStatuses,
} from '../../shared/status.ts';
import { inLiterals } from '../db/checks.ts';
import type { Data, Db } from '../db/index.ts';
import { media, requestEvents, requestSeasons, requests, seasons as seasonStatuses, users } from '../db/schema.ts';
import { arrKindOf } from '../integrations/arr.ts';
import { IntegrationError } from '../integrations/http.ts';
import { addMovie } from '../integrations/radarr.ts';
import { addSeries } from '../integrations/sonarr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError, NotConfiguredError, UpstreamContractError } from '../lib/api-errors.ts';
import { one } from '../lib/sql.ts';
import { DAY_MS } from '../lib/time.ts';
import type { SessionViewer } from '../plugins/auth.ts';
import type { AvailabilityService } from './availability.ts';
import { notifyRequestEvent } from './notifications.ts';
import { assertSendChoice } from './send-options.ts';
import { getSetting } from './settings.ts';
import { loadDetails, loadSummaries } from './tmdb.ts';
import { avatarUrlOf, type User } from './users.ts';

type CreateInput = z.output<typeof createRequestSchema>;
type ListQuery = z.output<typeof requestListQuerySchema>;
type BatchInput = z.output<typeof batchRequestSchema>;
type Writer = Pick<Db, 'select' | 'insert' | 'update'>;

const ALREADY_AVAILABLE = 'Ce titre est déjà disponible dans Emby';
const NOT_FOUND = 'Demande introuvable';

// --- Quotas ---

export type QuotaKind = 'movies' | 'seasons';
const QUOTA_UNIT: Record<QuotaKind, [one: string, many: string]> = {
  movies: ['film', 'films'],
  seasons: ['saison', 'saisons'],
};
/** Refusées et annulées ne comptent pas dans le quota. */
const UNCOUNTED: RequestStatus[] = ['declined', 'cancelled'];

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n > 1 ? many : one}`;
export const quotaMessage = (kind: QuotaKind, rule: QuotaRule) =>
  `Quota atteint : ${plural(rule.limit, QUOTA_UNIT[kind])} sur ${plural(rule.days, ['jour', 'jours'])}`;

/**
 * Films (demandes) ou saisons (saisons demandées) d'un membre depuis `since`, hors refusées et annulées. Servies
 * par l'index `requests(user_id, created_at)`.
 */
export function quotaUsageQuery(db: Pick<Db, 'select'>, userId: string, kind: QuotaKind, since: Date) {
  const counted = and(
    eq(requests.userId, userId),
    gte(requests.createdAt, since),
    notInArray(requests.status, UNCOUNTED),
  );
  return kind === 'movies'
    ? db
        .select({ n: count() })
        .from(requests)
        .innerJoin(media, eq(media.id, requests.mediaId))
        .where(and(counted, eq(media.type, 'movie')))
    : db
        .select({ n: count() })
        .from(requestSeasons)
        .innerJoin(requests, eq(requests.id, requestSeasons.requestId))
        .where(counted);
}

// --- Lignes ---

const rowColumns = {
  ...getTableColumns(requests),
  type: media.type,
  tmdbId: media.tmdbId,
  tvdbId: media.tvdbId,
};
type RequestRow = typeof requests.$inferSelect & { type: MediaType; tmdbId: number; tvdbId: number | null };

const selectRows = (db: Pick<Db, 'select'>) =>
  db.select(rowColumns).from(requests).innerJoin(media, eq(media.id, requests.mediaId));

const inStatuses = (statuses: readonly RequestStatus[]) => inArray(requests.status, [...statuses]);
const isActive = inStatuses(activeRequestStatuses);
/** Demandes en cours d'un titre, version ordinaire : une demande 4K (importée de Seerr) ne la couvre pas. */
const activeOrdinaryOn = (mediaId: number) => and(eq(requests.mediaId, mediaId), eq(requests.is4k, false), isActive);

/** Périmètre d'une liste : les demandes d'un membre (`userId`) ou toutes, éventuellement d'un seul titre. */
export interface ListScope {
  userId?: string;
  title?: { type: MediaType; tmdbId?: number };
}

/** Filtre du périmètre, sans jointure : le titre passe par l'index unique `media(type, tmdb_id)`. */
export const scopeWhere = ({ userId, title }: ListScope) =>
  and(
    userId === undefined ? undefined : eq(requests.userId, userId),
    title &&
      inArray(
        requests.mediaId,
        sql`(select ${media.id} from ${media} where ${and(
          eq(media.type, title.type),
          title.tmdbId === undefined ? undefined : eq(media.tmdbId, title.tmdbId),
        )})`,
      ),
  );

/** Nombre de demandes par statut du périmètre, en un `GROUP BY`. */
export const requestTotalsQuery = (db: Pick<Db, 'select'>, scope: ListScope) =>
  db.select({ status: requests.status, n: count() }).from(requests).where(scopeWhere(scope)).groupBy(requests.status);

/** Page d'une liste, plus récentes d'abord. */
export const requestPageQuery = (
  db: Pick<Db, 'select'>,
  scope: ListScope,
  statuses: readonly RequestStatus[] | undefined,
  page: number,
) =>
  selectRows(db)
    .where(and(scopeWhere(scope), statuses && inStatuses(statuses)))
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(REQUESTS_PAGE_SIZE)
    .offset((page - 1) * REQUESTS_PAGE_SIZE);

/**
 * Détail du dernier évènement `failed` de chaque demande, en une requête pour toute la page (SQLite garantit que les
 * colonnes nues d'un `max()` viennent de la ligne retenue). Servie par l'index `request_events(request_id, created_at)`.
 */
export const lastFailureQuery = (db: Pick<Db, 'select'>, ids: number[]) =>
  db
    .select({ requestId: requestEvents.requestId, detail: requestEvents.detail, last: max(requestEvents.id) })
    .from(requestEvents)
    .where(and(inArray(requestEvents.requestId, ids), eq(requestEvents.type, 'failed')))
    .groupBy(requestEvents.requestId);

/**
 * « ON CONFLICT DO NOTHING » sur l'index partiel `requests_active`, dont le `WHERE` doit être repris pour que SQLite
 * l'utilise. Drizzle place le `where` de `onConflictDoNothing` après `DO NOTHING` (SQL invalide) : on passe donc par
 * `onConflictDoUpdate` avec `targetWhere`, et une mise à jour qui ne s'applique jamais (`WHERE 0`), soit l'équivalent
 * exact de `DO NOTHING` (aucune ligne modifiée, rien de renvoyé par `RETURNING`).
 */
export const ACTIVE_CONFLICT = {
  target: [requests.mediaId, requests.userId, requests.is4k],
  targetWhere: inLiterals(requests.status, preSendRequestStatuses),
  set: { status: sql`${requests.status}` },
  setWhere: sql`0`,
};

const toPerson = (user: User): RequestPerson => ({ id: user.id, name: user.name, avatarUrl: avatarUrlOf(user) });

function addEvent(
  tx: Writer,
  requestId: number,
  type: RequestEventType,
  actorId: string | null,
  at: Date,
  detail: string | null = null,
) {
  tx.insert(requestEvents).values({ requestId, type, actorId, detail, createdAt: at }).run();
  notifyRequestEvent(tx, { requestId, type, actorId, detail, at });
}

/**
 * Titre connu de l'appli (créé au besoin, statut à calculer) ; l'id TVDB (fiche TMDB, import Seerr) est gardé pour
 * Sonarr. Aussi utilisé par l'import Seerr.
 */
export function upsertMedia(tx: Writer, title: { type: MediaType; tmdbId: number; tvdbId: number | null }): number {
  return tx
    .insert(media)
    .values({
      type: title.type,
      tmdbId: title.tmdbId,
      tvdbId: title.tvdbId,
      // Date nulle : le statut de bibliothèque sera recalculé à la prochaine lecture.
      statusUpdatedAt: new Date(0),
    })
    .onConflictDoUpdate({
      target: [media.type, media.tmdbId],
      set: { tvdbId: sql`coalesce(${media.tvdbId}, excluded.tvdb_id)` },
    })
    .returning({ id: media.id })
    .get().id;
}

/**
 * Demande de ce membre sur ce titre (au plus une avant envoi, index `requests_active`) : par défaut avant envoi,
 * `statuses` élargit la recherche (un film déjà envoyé reste « sa » demande).
 */
const ownActive = (
  tx: Pick<Db, 'select'>,
  mediaId: number,
  userId: string,
  statuses: readonly RequestStatus[] = preSendRequestStatuses,
) =>
  tx
    .select()
    .from(requests)
    .where(
      and(eq(requests.mediaId, mediaId), eq(requests.userId, userId), eq(requests.is4k, false), inStatuses(statuses)),
    )
    .get();

/**
 * Saisons à demander : celles choisies (`'all'` : toutes les saisons régulières déjà diffusées), moins celles déjà
 * disponibles dans Emby. Une saison inconnue de TMDB, les spéciaux ou une saison pas encore diffusée → 400 ; rien à
 * demander → 409.
 */
function wantedSeasons(details: MediaDetails, choice: number[] | 'all', today: string): number[] {
  const known = new Set(details.seasons.map((s) => s.seasonNumber));
  if (choice !== 'all' && choice.some((n) => !known.has(n))) throw new HttpError(400, 'Saison inconnue');
  const requestable = details.seasons.filter((s) => s.seasonNumber > 0 && isAiredSeason(s, today));
  const chosen = choice === 'all' ? requestable : details.seasons.filter((s) => choice.includes(s.seasonNumber));
  if (chosen.some((s) => !requestable.includes(s)))
    throw new HttpError(400, 'Les saisons spéciales et pas encore diffusées ne peuvent pas être demandées');
  const missing = chosen.filter((s) => s.status !== 'available').map((s) => s.seasonNumber);
  if (missing.length === 0)
    throw new HttpError(409, chosen.length === 0 ? 'Aucune saison diffusée à demander' : ALREADY_AVAILABLE);
  return missing.sort((a, b) => a - b);
}

/**
 * Démarrage : une demande restée `approved` a vu son envoi interrompu par l'arrêt précédent (l'appel à Radarr/Sonarr
 * se fait hors transaction). Elle passe en échec, avec un évènement, pour pouvoir être relancée.
 */
export function failInterruptedSends(db: Db, now = new Date()) {
  db.transaction((tx) => {
    const stuck = tx
      .update(requests)
      .set({ status: 'failed', updatedAt: now })
      .where(eq(requests.status, 'approved'))
      .returning({ id: requests.id })
      .all();
    for (const { id } of stuck) addEvent(tx, id, 'failed', null, now, 'Envoi interrompu (redémarrage) : à relancer');
  });
}

/**
 * Transition `sent → available`, la seule que la synchronisation pose : pour les titres `mediaIds` qui viennent d'être
 * recalculés, chaque demande envoyée dont le titre est arrivé (film disponible ; série disponible, ou chaque saison
 * demandée disponible) passe `available`, avec l'évènement `available`. Une saison encore manquante laisse la demande
 * `sent`. Rejouée sur le même état (webhook en double, balayage), elle ne trouve plus rien : aucun évènement en double.
 */
export function markAvailable(tx: Writer, mediaIds: readonly number[], at: Date): number[] {
  if (mediaIds.length === 0) return [];
  const ofRequest = eq(requestSeasons.requestId, requests.id);
  const seasonArrived = tx
    .select({ one })
    .from(seasonStatuses)
    .where(
      and(
        eq(seasonStatuses.mediaId, requests.mediaId),
        eq(seasonStatuses.seasonNumber, requestSeasons.seasonNumber),
        eq(seasonStatuses.status, 'available'),
      ),
    );
  const everySeasonArrived = and(
    exists(tx.select({ one }).from(requestSeasons).where(ofRequest)),
    notExists(
      tx
        .select({ one })
        .from(requestSeasons)
        .where(and(ofRequest, notExists(seasonArrived))),
    ),
  );
  const arrived = tx
    .select({ id: requests.id })
    .from(requests)
    .innerJoin(media, eq(media.id, requests.mediaId))
    .where(
      and(
        eq(requests.status, 'sent'),
        // Le cache ne connaît que la bibliothèque ordinaire : une demande 4K (importée de Seerr) n'arrive pas avec elle.
        eq(requests.is4k, false),
        inArray(requests.mediaId, [...mediaIds]),
        or(eq(media.status, 'available'), and(eq(media.type, 'tv'), everySeasonArrived)),
      ),
    )
    .all();
  if (arrived.length === 0) return [];
  const updated = tx
    .update(requests)
    .set({ status: 'available', updatedAt: at })
    .where(
      and(
        inArray(
          requests.id,
          arrived.map((r) => r.id),
        ),
        eq(requests.status, 'sent'),
      ),
    )
    .returning({ id: requests.id })
    .all();
  if (updated.length > 0)
    tx.insert(requestEvents)
      .values(updated.map(({ id }) => ({ requestId: id, type: 'available' as const, actorId: null, createdAt: at })))
      .run();
  return updated.map((r) => r.id);
}

type SendOutcome = { ok: true; detail: string; arrId: number; tvdbId?: number } | { ok: false; detail: string };

/** Erreurs au message lisible (service injoignable, non configuré, réponse inattendue) : affichées telles quelles. */
const readable = (error: unknown) =>
  error instanceof IntegrationError ||
  error instanceof NotConfiguredError ||
  error instanceof UpstreamContractError ||
  error instanceof HttpError;

/**
 * Demandes : création (droits, quotas, double clic), approbation, refus, annulation, envoi à Radarr/Sonarr et
 * relance. Toute transition est un `UPDATE … WHERE status = <attendu>` : deux approbateurs simultanés n'envoient
 * jamais deux fois. `sent → available` est posée par la synchronisation (`markAvailable`). Les appels réseau (TMDB, Radarr, Sonarr) se font hors transaction.
 */
export function createRequests(
  data: Data,
  deps: { tmdb: () => TmdbClient; availability: AvailabilityService; now?: () => number },
) {
  const { db, cryptoKey } = data;
  const now = deps.now ?? Date.now;

  // --- Quotas ---

  function quotaRules(user: User): Record<QuotaKind, QuotaRule> {
    const defaults = (getSetting(db, cryptoKey, 'rules') ?? settingSchemas.rules.parse({})).defaultQuota;
    return {
      movies: user.quotaOverride?.movies ?? defaults.movies,
      seasons: user.quotaOverride?.seasons ?? defaults.seasons,
    };
  }

  function usage(tx: Pick<Db, 'select'>, user: User, kind: QuotaKind, rule: QuotaRule) {
    const since = new Date(now() - rule.days * DAY_MS);
    const used = quotaUsageQuery(tx, user.id, kind, since).get()?.n ?? 0;
    return { ...rule, used, remaining: Math.max(0, rule.limit - used) };
  }

  /** Propriétaire et gestionnaires sont hors quotas. */
  function assertQuota(tx: Pick<Db, 'select'>, { user, capabilities }: SessionViewer, kind: QuotaKind, wanted: number) {
    if (capabilities.quotaExempt) return;
    const rule = quotaRules(user)[kind];
    const { remaining } = usage(tx, user, kind, rule);
    if (wanted > remaining) {
      const left = remaining > 0 ? ` (il en reste ${remaining})` : '';
      throw new HttpError(409, `${quotaMessage(kind, rule)}${left}`);
    }
  }

  function quota({ user, capabilities }: SessionViewer): RequestQuota {
    const rules = quotaRules(user);
    return {
      movies: usage(db, user, 'movies', rules.movies),
      seasons: usage(db, user, 'seasons', rules.seasons),
      exempt: capabilities.quotaExempt,
    };
  }

  // --- Lecture ---

  const rowOf = (id: number): RequestRow | undefined => selectRows(db).where(eq(requests.id, id)).get();

  /** Demande à lire, ou 404 ; avec `viewer`, 404 aussi si elle ne lui est pas visible. */
  function requireRow(id: number, viewer?: SessionViewer): RequestRow {
    const row = rowOf(id);
    if (!row || (viewer && !canSee(viewer, row))) throw new HttpError(404, NOT_FOUND);
    return row;
  }

  /** Numéros de saisons demandées, par demande, en ordre croissant. */
  function seasonsByRequest(ids: number[]): Map<number, number[]> {
    const seasonsOf = new Map<number, number[]>();
    for (const s of db
      .select()
      .from(requestSeasons)
      .where(inArray(requestSeasons.requestId, ids))
      .orderBy(asc(requestSeasons.seasonNumber))
      .all())
      seasonsOf.set(s.requestId, [...(seasonsOf.get(s.requestId) ?? []), s.seasonNumber]);
    return seasonsOf;
  }

  /** Vues d'une page de demandes : membres, saisons et résumés lus par lot. */
  async function toViews(rows: RequestRow[]): Promise<RequestView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [...new Set(rows.flatMap((r) => (r.decidedBy ? [r.userId, r.decidedBy] : [r.userId])))];
    const people = new Map(
      db
        .select()
        .from(users)
        .where(inArray(users.id, userIds))
        .all()
        .map((u) => [u.id, toPerson(u)]),
    );
    const seasonsOf = seasonsByRequest(ids);
    const failedIds = rows.filter((r) => r.status === 'failed').map((r) => r.id);
    const failures = new Map<number, string | null>();
    if (failedIds.length > 0)
      for (const f of lastFailureQuery(db, failedIds).all()) failures.set(f.requestId, f.detail);
    const titles = await loadSummaries(deps.tmdb, rows);
    const unknown = (id: string): RequestPerson => ({ id, name: id, avatarUrl: null });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      tmdbId: r.tmdbId,
      status: r.status,
      seasons: seasonsOf.get(r.id) ?? [],
      requester: people.get(r.userId) ?? unknown(r.userId),
      decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? unknown(r.decidedBy)) : null,
      declineReason: r.declineReason,
      qualityProfileId: r.qualityProfileId,
      rootFolder: r.rootFolder,
      seriesType: r.seriesType,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      media: titles.get(keyOf(r)) ?? null,
      failureReason: failures.get(r.id) ?? null,
    }));
  }

  /** Demande et sa frise (ordre chronologique ; même seconde → ordre d'insertion). */
  async function detailOf(id: number): Promise<RequestDetail> {
    const row = requireRow(id);
    const [view] = await toViews([row]);
    const events = db
      .select({ event: requestEvents, actor: users })
      .from(requestEvents)
      .leftJoin(users, eq(users.id, requestEvents.actorId))
      .where(eq(requestEvents.requestId, id))
      .orderBy(asc(requestEvents.createdAt), asc(requestEvents.id))
      .all();
    return {
      ...(view as RequestView),
      events: events.map(({ event, actor }) => ({
        id: event.id,
        type: event.type,
        actor: actor ? toPerson(actor) : null,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  const canSee = (viewer: SessionViewer, row: RequestRow) =>
    viewer.capabilities.canManageRequests || row.userId === viewer.user.id;

  // --- Transitions ---

  /**
   * `UPDATE … WHERE id = ? AND status IN (from)` : la seule façon de changer l'état d'une demande. Rien de modifié →
   * 404 si elle n'existe pas, 409 sinon (déjà traitée entre-temps).
   */
  function transition(
    tx: Writer,
    id: number,
    from: readonly RequestStatus[],
    set: Partial<typeof requests.$inferInsert> & { status: RequestStatus },
    conflict = 'Cette demande a déjà été traitée',
  ) {
    const updated = tx
      .update(requests)
      .set({ ...set, updatedAt: new Date(now()) })
      .where(and(eq(requests.id, id), inArray(requests.status, [...from])))
      .returning()
      .get();
    if (updated) return updated;
    const exists = tx.select({ id: requests.id }).from(requests).where(eq(requests.id, id)).get();
    throw new HttpError(exists ? 409 : 404, exists ? conflict : NOT_FOUND);
  }

  /** Ajoute le titre à Radarr ou Sonarr (avec recherche) ; un échec est rendu lisible, jamais levé. */
  async function deliver(row: RequestRow, seasons: number[]): Promise<SendOutcome> {
    try {
      if (row.type === 'movie') {
        const radarr = getSetting(db, cryptoKey, 'radarr');
        if (!radarr) throw new NotConfiguredError('Radarr');
        const { radarrId } = await addMovie(radarr, {
          tmdbId: row.tmdbId,
          qualityProfileId: row.qualityProfileId ?? radarr.qualityProfileId,
          rootFolderPath: row.rootFolder ?? radarr.rootFolderPath,
          minimumAvailability: radarr.minimumAvailability,
          search: true,
        });
        return { ok: true, arrId: radarrId, detail: `Radarr #${radarrId}` };
      }
      const sonarr = getSetting(db, cryptoKey, 'sonarr');
      if (!sonarr) throw new NotConfiguredError('Sonarr');
      const tvdbId = row.tvdbId ?? (await deps.tmdb().tvdbIdFor(row.tmdbId));
      if (tvdbId === null)
        return { ok: false, detail: 'Identifiant TVDB inconnu : Sonarr ne peut pas ajouter cette série' };
      const { sonarrId } = await addSeries(sonarr, {
        tvdbId,
        qualityProfileId: row.qualityProfileId ?? sonarr.qualityProfileId,
        rootFolderPath: row.rootFolder ?? sonarr.rootFolderPath,
        seriesType: row.seriesType ?? sonarr.seriesType,
        seasons,
        search: true,
        ...(sonarr.languageProfileId !== undefined && { languageProfileId: sonarr.languageProfileId }),
      });
      return { ok: true, arrId: sonarrId, tvdbId, detail: `Sonarr #${sonarrId}` };
    } catch (error) {
      if (readable(error)) return { ok: false, detail: (error as Error).message };
      console.error('Envoi de la demande', row.id, error);
      return { ok: false, detail: "Erreur inattendue pendant l'envoi" };
    }
  }

  /** Envoie une demande approuvée, puis la passe en `sent` (ids Radarr/Sonarr gardés) ou `failed` (détail lisible). */
  async function send(id: number, actor: User) {
    const row = requireRow(id);
    const outcome = await deliver(row, seasonsByRequest([id]).get(id) ?? []);
    db.transaction((tx) => {
      const at = new Date(now());
      const updated = tx
        .update(requests)
        .set({ status: outcome.ok ? 'sent' : 'failed', updatedAt: at })
        .where(and(eq(requests.id, id), eq(requests.status, 'approved')))
        .returning({ id: requests.id })
        .get();
      if (!updated) return; // changée entre-temps : rien à écrire
      addEvent(tx, id, outcome.ok ? 'sent' : 'failed', actor.id, at, outcome.detail);
      if (outcome.ok)
        tx.update(media)
          .set(
            row.type === 'movie'
              ? { radarrId: outcome.arrId }
              : { sonarrId: outcome.arrId, ...(outcome.tvdbId !== undefined && { tvdbId: outcome.tvdbId }) },
          )
          .where(eq(media.id, row.mediaId))
          .run();
    });
  }

  /** Pas de Radarr/Sonarr 4K : une demande 4K (importée de Seerr) ne part jamais vers l'instance ordinaire. */
  function assertNot4k(row: RequestRow) {
    if (row.is4k) throw new HttpError(409, 'Les demandes 4K ne sont pas prises en charge');
  }

  async function approve(id: number, actor: User, choice: ApproveRequestInput = {}): Promise<RequestDetail> {
    const row = requireRow(id);
    assertNot4k(row);
    await assertSendChoice(data, row.type, choice);
    // Valeurs envoyées gardées sur la demande (une relance les reprend) ; à défaut, celles des réglages.
    const sonarr = row.type === 'tv' ? getSetting(db, cryptoKey, 'sonarr') : null;
    const defaults = getSetting(db, cryptoKey, arrKindOf(row.type));
    db.transaction((tx) => {
      transition(tx, id, ['pending'], {
        status: 'approved',
        decidedBy: actor.id,
        qualityProfileId: choice.qualityProfileId ?? defaults?.qualityProfileId ?? null,
        rootFolder: choice.rootFolderPath ?? defaults?.rootFolderPath ?? null,
        seriesType: row.type === 'tv' ? (choice.seriesType ?? sonarr?.seriesType ?? null) : null,
      });
      addEvent(tx, id, 'approved', actor.id, new Date(now()));
    });
    await send(id, actor);
    return detailOf(id);
  }

  async function retry(id: number, actor: User): Promise<RequestDetail> {
    assertNot4k(requireRow(id));
    db.transaction((tx) => {
      transition(tx, id, ['failed'], { status: 'approved' }, 'Seule une demande en échec peut être relancée');
      addEvent(tx, id, 'retried', actor.id, new Date(now()));
    });
    await send(id, actor);
    return detailOf(id);
  }

  async function decline(id: number, actor: User, reason: string): Promise<RequestDetail> {
    db.transaction((tx) => {
      transition(tx, id, ['pending', 'failed'], { status: 'declined', decidedBy: actor.id, declineReason: reason });
      addEvent(tx, id, 'declined', actor.id, new Date(now()), reason);
    });
    return detailOf(id);
  }

  async function cancel(id: number, viewer: SessionViewer): Promise<RequestDetail> {
    const row = requireRow(id, viewer);
    if (row.userId !== viewer.user.id) throw new HttpError(403, 'Seul le membre qui a fait la demande peut l’annuler');
    db.transaction((tx) => {
      transition(tx, id, ['pending'], { status: 'cancelled' }, 'Cette demande ne peut plus être annulée');
      addEvent(tx, id, 'cancelled', viewer.user.id, new Date(now()));
    });
    return detailOf(id);
  }

  // --- Création ---

  /**
   * Crée la demande (`created: true`), ou renvoie celle déjà en cours du membre (double clic, `created: false`).
   * Vérification du quota et insertion dans la même transaction. Rôle à approbation automatique → approuvée et
   * envoyée aussitôt.
   */
  async function create(
    viewer: SessionViewer,
    input: CreateInput,
  ): Promise<{ request: RequestDetail; created: boolean }> {
    const { user } = viewer;
    const details = await deps.availability.withDetailsStatus(await loadDetails(deps.tmdb(), input.type, input.tmdbId));
    let wanted: number[] = [];
    if (input.type === 'movie') {
      if (details.status === 'available') throw new HttpError(409, ALREADY_AVAILABLE);
    } else {
      wanted = wantedSeasons(details, input.seasons, isoDay(now()));
    }

    const outcome = db.transaction(
      (tx) => {
        const at = new Date(now());
        const mediaId = upsertMedia(tx, {
          type: details.type,
          tmdbId: details.tmdbId,
          tvdbId: details.externalIds.tvdb,
        });
        const own = ownActive(tx, mediaId, user.id, input.type === 'movie' ? activeRequestStatuses : undefined);

        const insert = (seasons: number[]) => {
          const row = tx
            .insert(requests)
            .values({ mediaId, userId: user.id, status: 'pending', createdAt: at, updatedAt: at })
            .onConflictDoUpdate(ACTIVE_CONFLICT)
            .returning({ id: requests.id })
            .get();
          if (!row) {
            // Conflit sur `requests_active` : une demande en cours existe déjà (double clic), renvoyée telle quelle.
            const existing = ownActive(tx, mediaId, user.id);
            if (!existing) throw new HttpError(409, 'Une demande est déjà en cours pour ce titre');
            return { id: existing.id, created: false };
          }
          if (seasons.length > 0)
            tx.insert(requestSeasons)
              .values(seasons.map((seasonNumber) => ({ requestId: row.id, seasonNumber })))
              .run();
          addEvent(tx, row.id, 'requested', user.id, at);
          return { id: row.id, created: true };
        };

        if (input.type === 'movie') {
          if (own) return { id: own.id, created: false };
          if (tx.select({ id: requests.id }).from(requests).where(activeOrdinaryOn(mediaId)).get())
            throw new HttpError(409, 'Ce titre est déjà demandé');
          assertQuota(tx, viewer, 'movies', 1);
          return insert([]);
        }

        // Série : seules les saisons que personne n'a déjà demandées.
        const active = tx
          .select({ requestId: requestSeasons.requestId, n: requestSeasons.seasonNumber })
          .from(requestSeasons)
          .innerJoin(requests, eq(requests.id, requestSeasons.requestId))
          .where(activeOrdinaryOn(mediaId))
          .all();
        const covered = new Set(active.map((s) => s.n));
        const missing = wanted.filter((n) => !covered.has(n));
        if (missing.length === 0) {
          // Double clic : sa propre demande contient déjà toutes ces saisons.
          const mine = new Set(active.filter((s) => s.requestId === own?.id).map((s) => s.n));
          if (own && wanted.every((n) => mine.has(n))) return { id: own.id, created: false };
          throw new HttpError(409, 'Ces saisons sont déjà demandées');
        }
        // Une seule demande en cours par membre et par titre : tant qu'elle attend, les nouvelles saisons s'y ajoutent.
        if (own && own.status !== 'pending') throw new HttpError(409, 'Une demande est déjà en cours pour ce titre');
        assertQuota(tx, viewer, 'seasons', missing.length);
        if (!own) return insert(missing);
        tx.insert(requestSeasons)
          .values(missing.map((seasonNumber) => ({ requestId: own.id, seasonNumber })))
          .run();
        tx.update(requests).set({ updatedAt: at }).where(eq(requests.id, own.id)).run();
        addEvent(tx, own.id, 'requested', user.id, at, `Saisons ajoutées : ${missing.join(', ')}`);
        return { id: own.id, created: false };
      },
      { behavior: 'immediate' },
    );

    if (viewer.capabilities.autoApprove && rowOf(outcome.id)?.status === 'pending') {
      try {
        return { request: await approve(outcome.id, user), created: outcome.created };
      } catch (error) {
        // Double clic : un appel concurrent l'a déjà approuvée ou envoyée, on renvoie son état actuel.
        if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      }
    }
    return { request: await detailOf(outcome.id), created: outcome.created };
  }

  // --- Listes et compteurs ---

  /** Une page, et le nombre de demandes par statut du périmètre (le total de la page s'en déduit). */
  async function list(viewer: SessionViewer, query: ListQuery): Promise<RequestPage> {
    const onlyMine = query.mine || !viewer.capabilities.canManageRequests;
    const scope: ListScope = {
      ...(onlyMine && { userId: viewer.user.id }),
      ...(query.type && { title: { type: query.type, tmdbId: query.tmdbId } }),
    };
    const totals = Object.fromEntries(requestStatuses.map((s) => [s, 0])) as RequestPage['totals'];
    for (const { status, n } of requestTotalsQuery(db, scope).all()) totals[status] = n;
    const counted: readonly RequestStatus[] = query.status ?? requestStatuses;
    const total = counted.reduce((sum, s) => sum + totals[s], 0);
    const rows = total === 0 ? [] : requestPageQuery(db, scope, query.status, query.page).all();
    return {
      page: query.page,
      totalPages: Math.ceil(total / REQUESTS_PAGE_SIZE),
      results: await toViews(rows),
      totals,
    };
  }

  async function get(viewer: SessionViewer, id: number): Promise<RequestDetail> {
    requireRow(id, viewer);
    return detailOf(id);
  }

  function counts(viewer: SessionViewer): RequestCounts {
    const n = (where: SQL | undefined) => db.select({ n: count() }).from(requests).where(where).get()?.n ?? 0;
    return {
      pendingApprovals: viewer.capabilities.canManageRequests ? n(eq(requests.status, 'pending')) : null,
      mineActive: n(and(eq(requests.userId, viewer.user.id), isActive)),
    };
  }

  /** Approbation ou refus groupés : chaque demande est traitée à part, un refus métier n'arrête pas les autres. */
  async function batch(actor: User, input: BatchInput): Promise<BatchResult> {
    const results: BatchResult['results'] = [];
    for (const id of new Set(input.ids)) {
      try {
        const request = input.action === 'approve' ? await approve(id, actor) : await decline(id, actor, input.reason);
        results.push({ id, ok: true, request });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({ id, ok: false, error: error.message });
      }
    }
    return { results };
  }

  return { create, list, get, approve, decline, cancel, retry, batch, quota, counts };
}

export type RequestService = ReturnType<typeof createRequests>;
