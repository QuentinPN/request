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
import { arrLabel } from '../../shared/arr-servers.ts';
import { keyOf, type MediaDetails, type MediaType, type Season } from '../../shared/media.ts';
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
import { capabilitiesOf, type QuotaRule } from '../../shared/roles.ts';
import { DEFAULT_SERIES_TYPE, settingSchemas } from '../../shared/settings.ts';
import {
  activeRequestStatuses,
  preSendRequestStatuses,
  type RequestEventType,
  type RequestStatus,
  requestStatuses,
} from '../../shared/status.ts';
import { inLiterals } from '../db/checks.ts';
import type { Data, Db } from '../db/index.ts';
import { arrServers, media, requestEvents, requestSeasons, requests, users } from '../db/schema.ts';
import { seasonsTableOf } from '../db/seasons.ts';
import { arrKindOf } from '../integrations/arr.ts';
import { IntegrationError } from '../integrations/http.ts';
import { addMovie } from '../integrations/radarr.ts';
import { addSeries } from '../integrations/sonarr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError, NotConfiguredError, UpstreamContractError } from '../lib/api-errors.ts';
import { one } from '../lib/sql.ts';
import { DAY_MS } from '../lib/time.ts';
import type { SessionViewer } from '../plugins/auth.ts';
import { hasArrServer } from './arr-servers.ts';
import type { AvailabilityService } from './availability.ts';
import { assertNotBlocked, assertTitleNotBlocked } from './blocklist.ts';
import { notifyRequestEvent, notifyRequestedOnBehalf } from './notifications.ts';
import { assertSendChoice, sendServer } from './send-options.ts';
import { getSetting } from './settings.ts';
import { loadDetails, loadSummaries } from './tmdb.ts';
import { avatarUrlOf, getUser, type User } from './users.ts';

type CreateInput = z.output<typeof createRequestSchema>;
type ListQuery = z.output<typeof requestListQuerySchema>;
type BatchInput = z.output<typeof batchRequestSchema>;
type Writer = Pick<Db, 'select' | 'insert' | 'update'>;
/** Membre à qui une demande appartient, avec ses droits (quota, approbation automatique). */
type Owner = Pick<SessionViewer, 'user' | 'capabilities'>;

const ALREADY_AVAILABLE = 'Ce titre est déjà disponible dans Emby';
const alreadyAvailable = (is4k: boolean) => (is4k ? 'Ce titre est déjà disponible en 4K' : ALREADY_AVAILABLE);
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
 * Films (demandes) ou saisons (saisons demandées) d'un membre depuis `since`, hors refusées, annulées et demandes
 * exemptées (« Hors quota »). Servies par l'index `requests(user_id, created_at)`.
 */
export function quotaUsageQuery(db: Pick<Db, 'select'>, userId: string, kind: QuotaKind, since: Date) {
  const counted = and(
    eq(requests.userId, userId),
    gte(requests.createdAt, since),
    notInArray(requests.status, UNCOUNTED),
    eq(requests.quotaExempt, false),
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
/** Demandes en cours d'un titre dans une qualité : une demande 4K ne couvre pas la version normale, ni l'inverse. */
const activeOn = (mediaId: number, is4k: boolean) =>
  and(eq(requests.mediaId, mediaId), eq(requests.is4k, is4k), isActive);

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

export const toPerson = (user: User): RequestPerson => ({ id: user.id, name: user.name, avatarUrl: avatarUrlOf(user) });

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
 * Demande de ce membre sur ce titre dans cette qualité (au plus une avant envoi, index `requests_active`) : par défaut
 * avant envoi, `statuses` élargit la recherche (un film déjà envoyé reste « sa » demande).
 */
const ownActive = (
  tx: Pick<Db, 'select'>,
  mediaId: number,
  userId: string,
  is4k: boolean,
  statuses: readonly RequestStatus[] = preSendRequestStatuses,
) =>
  tx
    .select()
    .from(requests)
    .where(
      and(eq(requests.mediaId, mediaId), eq(requests.userId, userId), eq(requests.is4k, is4k), inStatuses(statuses)),
    )
    .get();

/** Statut d'un titre ou d'une saison dans la qualité demandée (4K : serveurs 4K seuls). */
const statusIn = (item: Pick<MediaDetails | Season, 'status' | 'fourK'>, is4k: boolean) =>
  is4k ? item.fourK?.status : item.status;

/**
 * Saisons à demander : celles choisies (`'all'` : toutes les saisons régulières déjà diffusées), moins celles déjà
 * disponibles dans cette qualité. Une saison inconnue de TMDB, les spéciaux ou une saison pas encore diffusée → 400 ;
 * rien à demander → 409.
 */
function wantedSeasons(details: MediaDetails, choice: number[] | 'all', today: string, is4k: boolean): number[] {
  const known = new Set(details.seasons.map((s) => s.seasonNumber));
  if (choice !== 'all' && choice.some((n) => !known.has(n))) throw new HttpError(400, 'Saison inconnue');
  const requestable = details.seasons.filter((s) => s.seasonNumber > 0 && isAiredSeason(s, today));
  const chosen = choice === 'all' ? requestable : details.seasons.filter((s) => choice.includes(s.seasonNumber));
  if (chosen.some((s) => !requestable.includes(s)))
    throw new HttpError(400, 'Les saisons spéciales et pas encore diffusées ne peuvent pas être demandées');
  const missing = chosen.filter((s) => statusIn(s, is4k) !== 'available').map((s) => s.seasonNumber);
  if (missing.length === 0)
    throw new HttpError(409, chosen.length === 0 ? 'Aucune saison diffusée à demander' : alreadyAvailable(is4k));
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
 * Sources du statut de chaque qualité : `media.status` et `seasons` (bibliothèque normale), `media.status_4k` et
 * `seasons_4k` (serveurs 4K). Mêmes colonnes : la table 4K se lit comme la normale.
 */
const QUALITIES = [
  { is4k: false, status: media.status, seasons: seasonsTableOf(false) },
  { is4k: true, status: media.status4k, seasons: seasonsTableOf(true) },
] as const;

/**
 * Transition `sent → available`, la seule que la synchronisation pose : pour les titres `mediaIds` qui viennent d'être
 * recalculés, chaque demande envoyée dont le titre est arrivé dans sa qualité (film disponible ; série disponible, ou
 * chaque saison demandée disponible ; en 4K, d'après les serveurs 4K) passe `available`, avec l'évènement `available`.
 * Une saison encore manquante laisse la demande `sent`. Rejouée sur le même état (webhook en double, balayage), elle ne
 * trouve plus rien : aucun évènement en double.
 */
export function markAvailable(tx: Writer, mediaIds: readonly number[], at: Date): number[] {
  if (mediaIds.length === 0) return [];
  const ofRequest = eq(requestSeasons.requestId, requests.id);
  const arrived = QUALITIES.flatMap(({ is4k, status, seasons }) => {
    const seasonArrived = tx
      .select({ one })
      .from(seasons)
      .where(
        and(
          eq(seasons.mediaId, requests.mediaId),
          eq(seasons.seasonNumber, requestSeasons.seasonNumber),
          eq(seasons.status, 'available'),
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
    return tx
      .select({ id: requests.id })
      .from(requests)
      .innerJoin(media, eq(media.id, requests.mediaId))
      .where(
        and(
          eq(requests.status, 'sent'),
          eq(requests.is4k, is4k),
          inArray(requests.mediaId, [...mediaIds]),
          or(eq(status, 'available'), and(eq(media.type, 'tv'), everySeasonArrived)),
        ),
      )
      .all();
  });
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

type SendOutcome =
  | { ok: true; detail: string; is4k: boolean; arrId: number; tvdbId?: number }
  | { ok: false; detail: string };

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
  function assertQuota(tx: Pick<Db, 'select'>, { user, capabilities }: Owner, kind: QuotaKind, wanted: number) {
    if (capabilities.quotaExempt) return;
    const rule = quotaRules(user)[kind];
    const { remaining } = usage(tx, user, kind, rule);
    if (wanted > remaining) {
      const left = remaining > 0 ? ` (il en reste ${remaining})` : '';
      throw new HttpError(409, `${quotaMessage(kind, rule)}${left}`);
    }
  }

  /**
   * Membre `forUserId` vu par `viewer` : lui-même, ou un autre membre (droit « Demander pour un autre », sinon 403 ;
   * inconnu → 404), avec les droits de son rôle.
   */
  function ownerFor(viewer: SessionViewer, forUserId: string | undefined): Owner {
    if (forUserId === undefined || forUserId === viewer.user.id) return viewer;
    if (!viewer.capabilities.canRequestOnBehalf)
      throw new HttpError(403, 'Vous ne pouvez pas demander à la place d’un autre membre');
    const user = getUser(db, forUserId);
    if (!user) throw new HttpError(404, 'Membre introuvable');
    return { user, capabilities: capabilitiesOf(user.role) };
  }

  /** Quota du membre connecté, ou d'un autre membre (`forUserId`, voir `ownerFor`). */
  function quota(viewer: SessionViewer, forUserId?: string): RequestQuota {
    const { user, capabilities } = ownerFor(viewer, forUserId);
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
    const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.decidedBy, r.createdBy].filter((id) => id !== null)))];
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
    const serverIds = [...new Set(rows.flatMap((r) => (r.serverId === null ? [] : [r.serverId])))];
    const serverNames = new Map(
      serverIds.length === 0
        ? []
        : db
            .select({ id: arrServers.id, name: arrServers.name })
            .from(arrServers)
            .where(inArray(arrServers.id, serverIds))
            .all()
            .map((s) => [s.id, s.name]),
    );
    const titles = await loadSummaries(deps.tmdb, rows);
    const unknown = (id: string): RequestPerson => ({ id, name: id, avatarUrl: null });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      tmdbId: r.tmdbId,
      status: r.status,
      seasons: seasonsOf.get(r.id) ?? [],
      requester: people.get(r.userId) ?? unknown(r.userId),
      createdBy: r.createdBy ? (people.get(r.createdBy) ?? unknown(r.createdBy)) : null,
      quotaExempt: r.quotaExempt,
      decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? unknown(r.decidedBy)) : null,
      declineReason: r.declineReason,
      qualityProfileId: r.qualityProfileId,
      rootFolder: r.rootFolder,
      seriesType: r.seriesType,
      is4k: r.is4k,
      server: r.serverId === null ? null : { id: r.serverId, name: serverNames.get(r.serverId) ?? '' },
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

  /** Serveur d'envoi : `chosen`, sinon le serveur par défaut du type et de la qualité ; `null` s'il n'y en a aucun. */
  function serverFor(row: RequestRow, chosen: number | null | undefined) {
    try {
      return sendServer(data, row.type, row.is4k, chosen);
    } catch (error) {
      if (error instanceof NotConfiguredError) return null;
      throw error;
    }
  }

  /**
   * Ajoute le titre au serveur de la demande (à défaut, celui par défaut du type et de la qualité), avec recherche ;
   * un échec est rendu lisible, jamais levé.
   */
  async function deliver(row: RequestRow, seasons: number[]): Promise<SendOutcome> {
    try {
      const server = sendServer(data, row.type, row.is4k, row.serverId);
      const target = {
        qualityProfileId: row.qualityProfileId ?? server.qualityProfileId,
        rootFolderPath: row.rootFolder ?? server.rootFolderPath,
        search: true,
      };
      if (row.type === 'movie') {
        const { radarrId } = await addMovie(server, {
          ...target,
          tmdbId: row.tmdbId,
          ...(server.minimumAvailability && { minimumAvailability: server.minimumAvailability }),
        });
        return { ok: true, is4k: server.is4k, arrId: radarrId, detail: `${server.name} #${radarrId}` };
      }
      const tvdbId = row.tvdbId ?? (await deps.tmdb().tvdbIdFor(row.tmdbId));
      if (tvdbId === null)
        return { ok: false, detail: 'Identifiant TVDB inconnu : Sonarr ne peut pas ajouter cette série' };
      const { sonarrId } = await addSeries(server, {
        ...target,
        tvdbId,
        seriesType: row.seriesType ?? server.seriesType ?? DEFAULT_SERIES_TYPE,
        seasons,
        ...(server.languageProfileId !== null && { languageProfileId: server.languageProfileId }),
      });
      return { ok: true, is4k: server.is4k, arrId: sonarrId, tvdbId, detail: `${server.name} #${sonarrId}` };
    } catch (error) {
      if (readable(error)) return { ok: false, detail: (error as Error).message };
      console.error('Envoi de la demande', row.id, error);
      return { ok: false, detail: "Erreur inattendue pendant l'envoi" };
    }
  }

  /**
   * Envoie une demande approuvée, puis la passe en `sent` (id sur le serveur gardé, comme indice : voir
   * `docs/DATA_MODEL.md`) ou `failed` (détail lisible).
   */
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
      if (!outcome.ok) return;
      const tvdbId = outcome.tvdbId !== undefined && { tvdbId: outcome.tvdbId };
      tx.update(media)
        .set(
          row.type === 'movie'
            ? outcome.is4k
              ? { radarr4kId: outcome.arrId }
              : { radarrId: outcome.arrId }
            : outcome.is4k
              ? { sonarr4kId: outcome.arrId, ...tvdbId }
              : { sonarrId: outcome.arrId, ...tvdbId },
        )
        .where(eq(media.id, row.mediaId))
        .run();
    });
  }

  async function approve(id: number, actor: User, choice: ApproveRequestInput = {}): Promise<RequestDetail> {
    const row = requireRow(id);
    // Serveur choisi par l'approbateur (du bon type et de la bonne qualité, sinon 400), sinon celui de la demande
    // (import Seerr), sinon le serveur par défaut. Aucun serveur : l'envoi échouera avec un message clair.
    const server = serverFor(row, choice.serverId ?? row.serverId);
    if (server) await assertSendChoice(server, choice);
    // Valeurs envoyées gardées sur la demande (une relance les reprend) ; à défaut, celles du serveur.
    db.transaction((tx) => {
      transition(tx, id, ['pending'], {
        status: 'approved',
        decidedBy: actor.id,
        serverId: server?.id ?? null,
        qualityProfileId: choice.qualityProfileId ?? server?.qualityProfileId ?? null,
        rootFolder: choice.rootFolderPath ?? server?.rootFolderPath ?? null,
        seriesType: row.type === 'tv' ? (choice.seriesType ?? server?.seriesType ?? null) : null,
        // « Hors quota » coché ou décoché à l'approbation ; absent, la demande garde le sien.
        ...(choice.quotaExempt !== undefined && { quotaExempt: choice.quotaExempt }),
      });
      addEvent(tx, id, 'approved', actor.id, new Date(now()));
    });
    await send(id, actor);
    return detailOf(id);
  }

  async function retry(id: number, actor: User): Promise<RequestDetail> {
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
   * Vérification du quota et insertion dans la même transaction. Rôle à approbation automatique (4K : approbation
   * automatique 4K) → approuvée et envoyée aussitôt. Une demande 4K suppose le droit et un serveur 4K du type ; elle
   * compte dans le quota comme une autre. Un titre bloqué (liste ou mot-clé) est refusé (403), pour tous.
   *
   * Pour un autre membre (`forUserId`, droit « Demander pour un autre ») : la demande est à lui. Son quota, ses droits
   * (4K, approbation automatique, en son nom) et sa demande en cours s'appliquent ; il est prévenu
   * (`requested_on_behalf`) et `created_by` garde l'auteur, acteur de l'évènement `requested`. « Hors quota »
   * (`quotaExempt`, gestionnaires) saute le quota et marque la demande. Des saisons ajoutées à une demande en attente
   * lui donnent l'exemption de l'ajout : hors quota, toute la demande l'est ; sinon elle ne l'est plus et le quota compte
   * toutes ses saisons. Un ajout pour autrui fusionné prévient le membre et renseigne `created_by` s'il est vide ; une
   * demande qui ne change rien (film déjà demandé, saisons déjà dedans) ne prévient personne.
   */
  async function create(
    viewer: SessionViewer,
    input: CreateInput,
  ): Promise<{ request: RequestDetail; created: boolean }> {
    if (input.quotaExempt && !viewer.capabilities.canManageRequests)
      throw new HttpError(403, 'Seul un gestionnaire peut mettre une demande hors quota');
    const owner = ownerFor(viewer, input.forUserId);
    const { user, capabilities } = owner;
    const author = viewer.user;
    const onBehalf = user.id !== author.id;
    const exempt = input.quotaExempt === true;
    const { is4k } = input;
    assertTitleNotBlocked(db, input);
    if (is4k) {
      if (!capabilities.canRequest4k) throw new HttpError(403, 'Vous ne pouvez pas demander en 4K');
      if (!hasArrServer(db, arrKindOf(input.type), true))
        throw new HttpError(409, `Aucun serveur ${arrLabel(arrKindOf(input.type), true)} n’est configuré`);
    }
    const details = await deps.availability.withDetailsStatus(await loadDetails(deps.tmdb(), input.type, input.tmdbId));
    assertNotBlocked(data, details);
    let wanted: number[] = [];
    if (input.type === 'movie') {
      if (statusIn(details, is4k) === 'available') throw new HttpError(409, alreadyAvailable(is4k));
    } else {
      wanted = wantedSeasons(details, input.seasons, isoDay(now()), is4k);
    }

    const outcome = db.transaction(
      (tx) => {
        const at = new Date(now());
        const mediaId = upsertMedia(tx, {
          type: details.type,
          tmdbId: details.tmdbId,
          tvdbId: details.externalIds.tvdb,
        });
        const own = ownActive(tx, mediaId, user.id, is4k, input.type === 'movie' ? activeRequestStatuses : undefined);
        const checkQuota = (kind: QuotaKind, n: number) => {
          if (!exempt) assertQuota(tx, owner, kind, n);
        };

        const insert = (seasons: number[]) => {
          const row = tx
            .insert(requests)
            .values({
              mediaId,
              userId: user.id,
              status: 'pending',
              is4k,
              quotaExempt: exempt,
              createdBy: onBehalf ? author.id : null,
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoUpdate(ACTIVE_CONFLICT)
            .returning({ id: requests.id })
            .get();
          if (!row) {
            // Conflit sur `requests_active` : une demande en cours existe déjà (double clic), renvoyée telle quelle.
            const existing = ownActive(tx, mediaId, user.id, is4k);
            if (!existing) throw new HttpError(409, 'Une demande est déjà en cours pour ce titre');
            return { id: existing.id, created: false };
          }
          if (seasons.length > 0)
            tx.insert(requestSeasons)
              .values(seasons.map((seasonNumber) => ({ requestId: row.id, seasonNumber })))
              .run();
          addEvent(tx, row.id, 'requested', author.id, at);
          if (onBehalf) notifyRequestedOnBehalf(tx, { requestId: row.id, userId: user.id, actorId: author.id, at });
          return { id: row.id, created: true };
        };

        if (input.type === 'movie') {
          if (own) return { id: own.id, created: false };
          if (tx.select({ id: requests.id }).from(requests).where(activeOn(mediaId, is4k)).get())
            throw new HttpError(409, 'Ce titre est déjà demandé');
          checkQuota('movies', 1);
          return insert([]);
        }

        // Série : seules les saisons que personne n'a déjà demandées.
        const active = tx
          .select({ requestId: requestSeasons.requestId, n: requestSeasons.seasonNumber })
          .from(requestSeasons)
          .innerJoin(requests, eq(requests.id, requestSeasons.requestId))
          .where(activeOn(mediaId, is4k))
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
        if (!own) {
          checkQuota('seasons', missing.length);
          return insert(missing);
        }
        // La demande fusionnée prend l'exemption de l'ajout : sans elle, ses saisons jusque-là exemptées comptent aussi.
        const uncounted = own.quotaExempt ? active.filter((s) => s.requestId === own.id).length : 0;
        checkQuota('seasons', missing.length + uncounted);
        tx.insert(requestSeasons)
          .values(missing.map((seasonNumber) => ({ requestId: own.id, seasonNumber })))
          .run();
        tx.update(requests)
          .set({ updatedAt: at, quotaExempt: exempt, ...(onBehalf && { createdBy: own.createdBy ?? author.id }) })
          .where(eq(requests.id, own.id))
          .run();
        addEvent(tx, own.id, 'requested', author.id, at, `Saisons ajoutées : ${missing.join(', ')}`);
        if (onBehalf) notifyRequestedOnBehalf(tx, { requestId: own.id, userId: user.id, actorId: author.id, at });
        return { id: own.id, created: false };
      },
      { behavior: 'immediate' },
    );

    // Approbation automatique d'après les droits du membre, en son nom : il n'est pas prévenu de « sa » approbation.
    const autoApprove = is4k ? capabilities.autoApprove4k : capabilities.autoApprove;
    if (autoApprove && rowOf(outcome.id)?.status === 'pending') {
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
