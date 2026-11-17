import { and, eq, inArray, TransactionRollbackError } from 'drizzle-orm';
import type { SeerrImportResult, SeerrUnmatchedUser } from '../../shared/import.ts';
import { type MediaType, mediaTypes } from '../../shared/media.ts';
import { activeRequestStatuses, type RequestStatus } from '../../shared/status.ts';
import type { Db } from '../db/index.ts';
import { requestEvents, requestSeasons, requests, users } from '../db/schema.ts';
import { SEERR_MEDIA_AVAILABLE, SEERR_REQUEST, type SeerrRequest, type SeerrUser } from '../integrations/seerr.ts';
import { upsertMedia } from './requests.ts';
import type { User } from './users.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Demandes écrites par transaction : un import de plusieurs milliers ne bloque pas la base d'un seul tenant. */
const BATCH_SIZE = 200;
export const IMPORTED_DETAIL = 'Importée depuis Seerr';

/** Origine gardée sur la demande (`requests.external_ref`) : un nouvel import la reconnaît. */
const externalRefOf = (seerrId: number) => `seerr:${seerrId}`;

/** Ids Emby comparés sans casse ni tirets : Jellyseerr peut les écrire au format GUID. [?] */
const normalizeId = (id: string) => id.toLowerCase().replaceAll('-', '');
const normalizeName = (name: string) => name.trim().toLowerCase();

/**
 * Statut de l'appli d'une demande Seerr : approuvée = déjà envoyée à Radarr/Sonarr par Seerr (jamais renvoyée), ou
 * disponible si le titre l'est ; terminée = disponible ; en échec = relançable par un gestionnaire. `null` = inconnu.
 */
function statusOf(item: SeerrRequest): RequestStatus | null {
  const mediaStatus = item.is4k ? item.media?.status4k : item.media?.status;
  switch (item.status) {
    case SEERR_REQUEST.pending:
      return 'pending';
    case SEERR_REQUEST.approved:
      return mediaStatus === SEERR_MEDIA_AVAILABLE ? 'available' : 'sent';
    case SEERR_REQUEST.declined:
      return 'declined';
    case SEERR_REQUEST.failed:
      return 'failed';
    case SEERR_REQUEST.completed:
      return 'available';
    default:
      return null;
  }
}

const dateOf = (value: string | null | undefined): Date | null => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
};

/** Titre et saisons d'une demande Seerr ; `null` si rien d'exploitable (id TMDB absent, série sans saison). */
function titleOf(
  item: SeerrRequest,
): { type: MediaType; tmdbId: number; tvdbId: number | null; seasons: number[] } | null {
  const type = item.media?.mediaType ?? item.type;
  const tmdbId = item.media?.tmdbId;
  if (!mediaTypes.includes(type as MediaType) || !tmdbId || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const seasons =
    type === 'tv' ? [...new Set((item.seasons ?? []).map((s) => s.seasonNumber))].sort((a, b) => a - b) : [];
  if (type === 'tv' && seasons.length === 0) return null;
  return { type: type as MediaType, tmdbId, tvdbId: item.media?.tvdbId ?? null, seasons };
}

/** Correspondance des comptes Seerr et des membres : id Emby d'abord, puis nom sans casse (un nom en double ne vaut rien). */
function userMatcher(db: Pick<Db, 'select'>) {
  const local = db.select().from(users).all();
  const byId = new Map(local.map((u) => [normalizeId(u.id), u]));
  const byName = new Map<string, User | null>();
  for (const u of local) {
    const key = normalizeName(u.name);
    byName.set(key, byName.has(key) ? null : u);
  }
  return (seerr: SeerrUser): User | null => {
    if (seerr.jellyfinUserId) {
      const user = byId.get(normalizeId(seerr.jellyfinUserId));
      if (user) return user;
    }
    for (const name of [seerr.jellyfinUsername, seerr.username, seerr.plexUsername, seerr.displayName]) {
      const user = name ? byName.get(normalizeName(name)) : undefined;
      if (user) return user;
    }
    return null;
  };
}

const seerrUserName = (seerr: SeerrUser) =>
  seerr.displayName || seerr.username || seerr.jellyfinUsername || seerr.plexUsername || `Compte Seerr n° ${seerr.id}`;

interface Counts {
  imported: number;
  alreadyPresent: number;
  unmatchedMedia: number;
  skipped4k: number;
  unmatchedUsers: Map<number, SeerrUnmatchedUser>;
}

/**
 * Une demande Seerr : déjà importée (même `external_ref`), ou fondue dans la demande en cours du même membre sur le
 * même titre (saisons manquantes ajoutées tant qu'elle attend), ou créée avec sa date d'origine et un seul évènement
 * `requested` noté « Importée depuis Seerr ». Écritures directes : ni quota, ni notification, ni Radarr/Sonarr.
 */
function applyOne(tx: Tx, item: SeerrRequest | null, match: (u: SeerrUser) => User | null, counts: Counts) {
  const title = item && titleOf(item);
  const status = item && statusOf(item);
  if (!item || !title || !status) {
    counts.unmatchedMedia++;
    return;
  }
  // Pas de Radarr/Sonarr 4K : une demande 4K encore à traiter ne pourrait jamais partir (l'historique, lui, est repris).
  if (item.is4k && (status === 'pending' || status === 'failed')) {
    counts.skipped4k++;
    return;
  }
  const user = item.requestedBy ? match(item.requestedBy) : null;
  if (!user) {
    const key = item.requestedBy?.id ?? 0;
    const entry = counts.unmatchedUsers.get(key) ?? {
      seerrId: key,
      name: item.requestedBy ? seerrUserName(item.requestedBy) : 'Compte Seerr inconnu',
      requests: 0,
    };
    entry.requests++;
    counts.unmatchedUsers.set(key, entry);
    return;
  }

  const externalRef = externalRefOf(item.id);
  if (tx.select({ id: requests.id }).from(requests).where(eq(requests.externalRef, externalRef)).get()) {
    counts.alreadyPresent++;
    return;
  }

  const is4k = item.is4k ?? false;
  const mediaId = upsertMedia(tx, title);
  const isActive = (activeRequestStatuses as readonly RequestStatus[]).includes(status);
  const existing = isActive
    ? tx
        .select({ id: requests.id, status: requests.status })
        .from(requests)
        .where(
          and(
            eq(requests.mediaId, mediaId),
            eq(requests.userId, user.id),
            eq(requests.is4k, is4k),
            inArray(requests.status, [...activeRequestStatuses]),
          ),
        )
        .get()
    : undefined;
  if (existing) {
    // Deux demandes Seerr en attente pour des saisons différentes : une seule demande en cours, toutes ses saisons.
    if (existing.status === 'pending' && title.seasons.length > 0)
      tx.insert(requestSeasons)
        .values(title.seasons.map((seasonNumber) => ({ requestId: existing.id, seasonNumber })))
        .onConflictDoNothing()
        .run();
    counts.alreadyPresent++;
    return;
  }

  const createdAt = dateOf(item.createdAt) ?? new Date();
  const updatedAt = dateOf(item.updatedAt) ?? createdAt;
  const { id } = tx
    .insert(requests)
    .values({ mediaId, userId: user.id, status, is4k, externalRef, createdAt, updatedAt })
    .returning({ id: requests.id })
    .get();
  if (title.seasons.length > 0)
    tx.insert(requestSeasons)
      .values(title.seasons.map((seasonNumber) => ({ requestId: id, seasonNumber })))
      .run();
  tx.insert(requestEvents)
    .values({ requestId: id, type: 'requested', actorId: user.id, detail: IMPORTED_DETAIL, createdAt })
    .run();
  counts.imported++;
}

/**
 * Écrit les demandes lues dans Seerr, par lots de {@link BATCH_SIZE} (une transaction chacun). Aperçu (`dryRun`) :
 * exactement le même traitement dans une seule transaction annulée à la fin, donc les mêmes comptes et rien d'écrit.
 */
export function importSeerrRequests(
  db: Db,
  items: ReadonlyArray<SeerrRequest | null>,
  { dryRun }: { dryRun: boolean },
): SeerrImportResult {
  const counts: Counts = { imported: 0, alreadyPresent: 0, unmatchedMedia: 0, skipped4k: 0, unmatchedUsers: new Map() };
  const match = userMatcher(db);
  const applyAll = (tx: Tx, batch: ReadonlyArray<SeerrRequest | null>) => {
    for (const item of batch) applyOne(tx, item, match, counts);
  };

  if (dryRun) {
    try {
      db.transaction((tx) => {
        applyAll(tx, items);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  } else {
    for (let start = 0; start < items.length; start += BATCH_SIZE)
      db.transaction((tx) => applyAll(tx, items.slice(start, start + BATCH_SIZE)), { behavior: 'immediate' });
  }

  return {
    dryRun,
    total: items.length,
    imported: counts.imported,
    alreadyPresent: counts.alreadyPresent,
    unmatchedUsers: [...counts.unmatchedUsers.values()].sort((a, b) => b.requests - a.requests),
    unmatchedMedia: counts.unmatchedMedia,
    skipped4k: counts.skipped4k,
  };
}
