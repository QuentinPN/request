import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  keyOf,
  type MediaDetails,
  type MediaKey,
  type MediaSummary,
  type MediaType,
  type Season,
} from '../../shared/media.ts';
import type { WatchLink } from '../../shared/media-server.ts';
import type { MediaServerKind } from '../../shared/settings.ts';
import type {
  Availability,
  LibraryStatus,
  MediaStatus,
  RequestStatus,
  TitleAvailability,
} from '../../shared/status.ts';
import type { Data, Db } from '../db/index.ts';
import { media, requestSeasons, requests, seasons } from '../db/schema.ts';
import { seasonsTableOf } from '../db/seasons.ts';
import { type ArrKind, arrKindOf, getQueue, type QueueItem } from '../integrations/arr.ts';
import { type MediaItemQuery, type MediaServer, matchItems } from '../integrations/media-server.ts';
import { type LibraryMovie, listMovies } from '../integrations/radarr.ts';
import { type LibrarySeries, listSeries } from '../integrations/sonarr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { TtlLru } from '../lib/lru.ts';
import { keyPairsIn } from '../lib/sql.ts';
import { type ArrServerConfig, listArrServers, serversOf } from './arr-servers.ts';
import { createMediaServers, type MediaServers } from './media-server.ts';
import { notifyRequestEvent } from './notifications.ts';
import { markAvailable } from './requests.ts';

// --- Durées ---

/** Durée de vie du statut en base ; un titre en téléchargement est relu plus souvent (sa progression bouge). */
const STATUS_TTL_MS = 5 * 60 * 1000;
const DOWNLOADING_TTL_MS = 60 * 1000;
/** Listes complètes Radarr/Sonarr et files de téléchargement, partagées par les pages servies dans l'intervalle. */
const ARR_LIST_TTL_MS = 60 * 1000;
const QUEUE_TTL_MS = 30 * 1000;
/** Après un échec, un service n'est plus interrogé pendant ce délai : une panne ne ralentit pas chaque page. */
const BACKOFF_MS = 60 * 1000;
const LATEST_TTL_MS = 5 * 60 * 1000;
/** Balayage du serveur multimédia relu au plus une fois par fenêtre et par type, quelle que soit la rafale de webhooks. */
export const RESCAN_MIN_INTERVAL_MS = 30 * 1000;
type ScanType = MediaItemQuery['type'];
/** L'id du serveur Emby ne change pas : une lecture par heure suffit. */
const SERVER_ID_TTL_MS = 60 * 60 * 1000;
/** Taille de la rangée « Ajoutés récemment dans Emby ». */
export const LATEST_LIMIT = 20;

// --- Calcul pur du statut de bibliothèque ---

/** Statut tiré d'Emby, Radarr et Sonarr (sans les demandes) ; `progress` de 0 à 1 accompagne `downloading`. */
export interface LibraryState {
  status: LibraryStatus;
  progress?: number;
}

/** Ce que l'on sait d'une saison : épisodes présents, attendus, et progression de ceux en téléchargement. */
export interface SeasonFacts {
  seasonNumber: number;
  present: number;
  expected: number;
  queue: number[];
}

/** Ce que l'on sait d'un titre, rassemblé depuis les services configurés. */
export interface TitleFacts {
  inEmby: boolean;
  /** Film : fichier présent chez Radarr. */
  hasFile?: boolean;
  /** Progression de chaque élément en file (Radarr, ou Sonarr toutes saisons). */
  queue: number[];
  /** Série : saisons connues (Sonarr, ou Emby et TMDB sur la fiche) ; absent = inconnues. */
  seasons?: SeasonFacts[];
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const downloading = (queue: number[]): LibraryState => ({ status: 'downloading', progress: mean(queue) });

export function seasonState(season: SeasonFacts): LibraryState | null {
  if (season.expected > 0 && season.present >= season.expected) return { status: 'available' };
  if (season.queue.length > 0) return downloading(season.queue);
  if (season.present > 0) return { status: 'partial' };
  return null;
}

/**
 * Statut de bibliothèque d'un titre. Film : dans Emby (ou fichier chez Radarr) → disponible, sinon en file →
 * en téléchargement. Série : toutes les saisons régulières ayant des épisodes sont complètes → disponible ; sinon
 * en file → en téléchargement ; sinon au moins un épisode → partiel. Une série présente dans Emby dont on ignore les
 * saisons est disponible.
 */
export function libraryState(type: MediaType, facts: TitleFacts): LibraryState | null {
  if (type === 'movie') {
    if (facts.inEmby) return { status: 'available' };
    if (facts.queue.length > 0) return downloading(facts.queue);
    return facts.hasFile ? { status: 'available' } : null;
  }
  // Saison 0 (épisodes spéciaux) et saisons sans épisode attendu (pas encore diffusées) ne comptent pas.
  const states = (facts.seasons ?? []).filter((s) => s.seasonNumber > 0 && s.expected > 0).map(seasonState);
  if (states.length > 0 && states.every((s) => s?.status === 'available')) return { status: 'available' };
  if (facts.queue.length > 0) return downloading(facts.queue);
  if (states.some((s) => s !== null)) return { status: 'partial' };
  if (facts.inEmby) return { status: facts.seasons ? 'partial' : 'available' };
  return null;
}

type RequestDisplay = Extract<MediaStatus, 'requested' | 'pending' | 'declined'>;
/** Part « demandes » du statut, tirée des demandes de tous les membres (chacun voit « Demandé »). */
export type RequestState = { status: RequestDisplay } | null;

/**
 * Statut affiché pour chaque statut de demande : approuvée, envoyée ou en échec (relance à venir) → « Demandé ».
 * Annulée ou arrivée dans Emby : rien (la bibliothèque prend le relais).
 */
const REQUEST_DISPLAY: Partial<Record<RequestStatus, RequestDisplay>> = {
  pending: 'pending',
  approved: 'requested',
  sent: 'requested',
  failed: 'requested',
  declined: 'declined',
};
const shownRequestStatuses = Object.keys(REQUEST_DISPLAY) as RequestStatus[];
/** Plusieurs demandes sur un même titre (ou une même saison) : « Demandé » > « En attente » > « Refusé ». */
const DISPLAY_RANK: Record<RequestDisplay, number> = { requested: 3, pending: 2, declined: 1 };

/** Part « demandes » la plus forte de chaque clé, à partir de lignes `(clé, statut de demande)`. */
function strongestByKey<K>(rows: ReadonlyArray<{ key: K; status: RequestStatus }>): Map<K, RequestState> {
  const result = new Map<K, RequestState>();
  for (const { key, status } of rows) {
    const shown = REQUEST_DISPLAY[status];
    const current = result.get(key)?.status;
    if (shown && (!current || DISPLAY_RANK[shown] > DISPLAY_RANK[current])) result.set(key, { status: shown });
  }
  return result;
}

/**
 * Statut affiché, seule fusion des deux parts : disponible ou en téléchargement l'emportent sur une demande, une
 * demande l'emporte sur « partiel » ; rien de connu → pas de statut.
 */
export function displayStatus(library: LibraryState | null, request: RequestState): Availability {
  if (library && library.status !== 'partial') return library;
  return request ?? library ?? {};
}

/**
 * Copie d'un titre avec son statut tiré de `statuses` (clé `type:tmdbId`). Toujours une copie : les objets d'origine
 * sont partagés par le cache TMDB et ne doivent pas porter le statut d'une autre requête.
 */
export const withStatus = <T extends MediaKey>(statuses: ReadonlyMap<string, TitleAvailability>, item: T): T => ({
  ...item,
  ...statuses.get(keyOf(item)),
});

// --- Cache en base ---

type MediaRow = typeof media.$inferSelect;

/** `(type, tmdb_id) IN (VALUES …)` : lecture par lot servie par l'index unique `(type, tmdb_id)` de `media`. */
const mediaKeysIn = (keys: readonly MediaKey[]) => keyPairsIn(media.type, media.tmdbId, keys);

/** Lecture par lot des statuts d'une page d'affiches, en une requête servie par l'index unique `(type, tmdb_id)`. */
export function selectCached(db: Db, keys: readonly MediaKey[]) {
  return db.select().from(media).where(mediaKeysIn(keys));
}

/**
 * Part « demandes » de chaque titre (clé `type:tmdbId`) dans une qualité, en une requête pour toute une page
 * d'affiches : une demande 4K ne fait pas afficher « Demandé » sur la version normale, ni l'inverse.
 */
export function requestStatesFor(db: Db, keys: readonly MediaKey[], is4k = false): Map<string, RequestState> {
  if (keys.length === 0) return new Map();
  const rows = db
    .select({ type: media.type, tmdbId: media.tmdbId, status: requests.status })
    .from(media)
    .innerJoin(requests, eq(requests.mediaId, media.id))
    .where(and(mediaKeysIn(keys), eq(requests.is4k, is4k), inArray(requests.status, shownRequestStatuses)))
    .all();
  return strongestByKey(rows.map((row) => ({ key: keyOf(row), status: row.status })));
}

/** Part « demandes » de chaque saison d'une série dans une qualité (numéro de saison → état). */
function seasonRequestStates(db: Db, mediaId: number, is4k: boolean): Map<number, RequestState> {
  const rows = db
    .select({ key: requestSeasons.seasonNumber, status: requests.status })
    .from(requests)
    .innerJoin(requestSeasons, eq(requestSeasons.requestId, requests.id))
    .where(and(eq(requests.mediaId, mediaId), eq(requests.is4k, is4k), inArray(requests.status, shownRequestStatuses)))
    .all();
  return strongestByKey(rows);
}

type SeasonRow = { seasonNumber: number; status: LibraryStatus; episodesPresent: number; episodesExpected: number };

/** Statut d'une qualité (normale, ou 4K) : état, id sur le serveur où le titre a été trouvé, saisons. */
interface QualityUpdate {
  state: LibraryState | null;
  radarrId?: number;
  sonarrId?: number;
  /** Statut et épisodes (présents, attendus) par saison ; absent = saisons inconnues, les lignes existantes sont gardées. */
  seasons?: SeasonRow[];
}

interface Update extends QualityUpdate {
  key: MediaKey;
  tvdbId?: number;
  embyItemId?: string;
  /** Statut 4K (serveurs 4K seuls) ; absent = pas calculé cette fois (serveur 4K muet) : colonnes 4K inchangées. */
  fourK?: QualityUpdate;
}

/** Remplace les saisons d'un titre (normales ou 4K) par celles calculées. */
function replaceSeasons(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  table: typeof seasons,
  mediaId: number,
  rows: SeasonRow[],
) {
  tx.delete(table).where(eq(table.mediaId, mediaId)).run();
  if (rows.length > 0)
    tx.insert(table)
      .values(rows.map((s) => ({ mediaId, ...s })))
      .run();
}

/**
 * Écrit les statuts recalculés, puis, dans la même transaction, passe `available` les demandes envoyées dont le titre
 * est arrivé (`markAvailable`) : fiche, webhook ou balayage, tout recalcul fait avancer les demandes.
 */
function writeUpdates(db: Db, updates: Update[], now: Date) {
  db.transaction((tx) => {
    const written: number[] = [];
    for (const u of updates) {
      const ids = {
        radarrId: u.radarrId ?? null,
        sonarrId: u.sonarrId ?? null,
        embyItemId: u.embyItemId ?? null,
        status: u.state?.status ?? null,
        statusUpdatedAt: now,
        // Saisons calculées (même sans aucune ligne) : la durée de vie du cache s'applique alors à la fiche.
        ...(u.seasons && { seasonsComputedAt: now }),
        ...(u.fourK && {
          radarr4kId: u.fourK.radarrId ?? null,
          sonarr4kId: u.fourK.sonarrId ?? null,
          status4k: u.fourK.state?.status ?? null,
        }),
      };
      const row = tx
        .insert(media)
        .values({ type: u.key.type, tmdbId: u.key.tmdbId, tvdbId: u.tvdbId ?? null, ...ids })
        // L'id TVDB d'une série ne change pas : on garde celui déjà connu si cette fois il n'a pas été trouvé.
        .onConflictDoUpdate({
          target: [media.type, media.tmdbId],
          set: { ...ids, tvdbId: sql`coalesce(excluded.tvdb_id, ${media.tvdbId})` },
        })
        .returning({ id: media.id })
        .get();
      written.push(row.id);
      if (u.seasons) replaceSeasons(tx, seasons, row.id, u.seasons);
      if (u.fourK?.seasons) replaceSeasons(tx, seasonsTableOf(true), row.id, u.fourK.seasons);
    }
    for (const requestId of markAvailable(tx, written, now))
      notifyRequestEvent(tx, { requestId, type: 'available', actorId: null, detail: null, at: now });
  });
}

// --- Service ---

type Service = MediaServerKind | ArrKind;

/** Liste (films ou séries) et file d'un serveur, indexées pour la recherche d'un titre. */
interface ArrSource<T> {
  server: ArrServerConfig;
  items: T[];
  queue: Map<number, QueueItem[]>;
}

/** Saisons calculées → lignes du cache : seules celles qui ont un statut. */
const seasonRows = (facts: readonly SeasonFacts[]): SeasonRow[] =>
  facts.flatMap((s) => {
    const season = seasonState(s);
    return season
      ? [
          {
            seasonNumber: s.seasonNumber,
            status: season.status,
            episodesPresent: s.present,
            // Jamais moins que ce qui est déjà là (TMDB en retard sur Emby) : « 10/10 », pas « 11/10 ».
            episodesExpected: Math.max(s.expected, s.present),
          },
        ]
      : [];
  });

/** Film sur plusieurs serveurs : celui qui a le fichier, sinon le premier qui le connaît (défaut d'abord). */
function findMovie(sources: readonly ArrSource<LibraryMovie>[], tmdbId: number) {
  const hits = sources.flatMap((source) => {
    const movie = source.items.find((m) => m.tmdbId === tmdbId);
    return movie ? [{ source, movie }] : [];
  });
  return hits.find((h) => h.movie.hasFile) ?? hits[0];
}

/** Série sur plusieurs serveurs : le premier qui la connaît (par id TMDB, sinon TVDB), défaut d'abord. */
function findSeries(sources: readonly ArrSource<LibrarySeries>[], tmdbId: number, tvdbId: number | undefined) {
  for (const source of sources) {
    const series =
      source.items.find((s) => s.tmdbId === tmdbId) ??
      (tvdbId === undefined ? undefined : source.items.find((s) => s.tvdbId === tvdbId));
    if (series) return { source, series };
  }
  return undefined;
}

/** Série de la fiche, recalculée exactement : ses saisons TMDB et son id TVDB complètent Emby et Sonarr. */
interface ExactSeries {
  key: MediaKey;
  seasons: readonly Season[];
  tvdbId: number | null;
  lastAired: MediaDetails['lastAired'];
}

/**
 * Épisodes déjà diffusés d'une saison TMDB : tous si une saison plus récente a commencé, jusqu'au dernier épisode
 * diffusé pour la saison en cours, aucun pour une saison à venir. Sans « dernier épisode diffusé » (TMDB ne le donne
 * pas toujours), une saison compte tout entière une fois sa date de diffusion passée.
 */
function airedEpisodes(season: Season, lastAired: ExactSeries['lastAired'], today: string): number {
  if (lastAired) {
    if (season.seasonNumber < lastAired.seasonNumber) return season.episodeCount;
    return season.seasonNumber === lastAired.seasonNumber ? Math.min(lastAired.episodeNumber, season.episodeCount) : 0;
  }
  return season.airDate && season.airDate <= today ? season.episodeCount : 0;
}

const groupBy = <T, K>(items: readonly T[], keyFn: (item: T) => K | undefined) => {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (key !== undefined) map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
};
const progressOf = (items: readonly QueueItem[] | undefined) => (items ?? []).map((q) => q.progress);

/**
 * Statut de disponibilité des titres, calculé côté serveur et mis en cache dans `media`/`seasons`.
 *
 * Budget d'appels pour une page (titres périmés ou inconnus, lus et rafraîchis par lot) : Emby, une requête par type
 * et par bibliothèque suivie (par lots de 50 ids) ; Radarr, `/movie` et `/queue` ; Sonarr, `/series` et `/queue`
 * (listes gardées une minute, files 30 s). TMDB n'est appelé (`tvdbIdFor`, mis en cache) que si Sonarr ne donne pas
 * l'id TMDB de ses séries (v3). La fiche d'une série ajoute un appel Emby (épisodes par saison).
 *
 * Un service non configuré ne compte pas ; un service en échec laisse le cache tel quel (jamais d'erreur pour la page).
 */
export function createAvailability(
  data: Data,
  deps: { tmdb: () => TmdbClient; mediaServers?: MediaServers; now?: () => number },
) {
  const { db } = data;
  const mediaServers = deps.mediaServers ?? createMediaServers(data);
  const now = deps.now ?? Date.now;
  const lists = new TtlLru({ maxEntries: 32 });
  /** Listes « derniers ajouts » par membre : à part, pour ne pas évincer les listes de Radarr/Sonarr. */
  const latestLists = new TtlLru({ maxEntries: 256 });
  /**
   * Balayages du serveur multimédia (Jellyfin, Plex), à part et par type : un webhook Radarr les déclare périmés pour
   * les films, un webhook Sonarr pour les séries ; ils sont alors relus, au plus une fois par `RESCAN_MIN_INTERVAL_MS`.
   */
  const scans: Record<ScanType, TtlLru> = {
    movie: new TtlLru({ maxEntries: 4 }),
    series: new TtlLru({ maxEntries: 4 }),
  };
  const staleScans = new Set<ScanType>();
  const lastRescan = new Map<ScanType, number>();

  /** Oublie le balayage de ce type s'il a été déclaré périmé, sauf s'il vient déjà d'être relu (rafale de webhooks). */
  function freshenScan(type: ScanType) {
    if (!staleScans.has(type)) return;
    const last = lastRescan.get(type);
    if (last !== undefined && now() - last < RESCAN_MIN_INTERVAL_MS) return;
    staleScans.delete(type);
    lastRescan.set(type, now());
    scans[type].clear();
  }
  /** Clé `service:url` : changer l'adresse d'un service (réglages) lève tout de suite sa mise à l'écart. */
  const backoff = new Map<string, number>();

  const settingsOf = () => ({ media: mediaServers.current(), servers: listArrServers(data) });
  type Settings = ReturnType<typeof settingsOf>;

  /** Appel protégé : `undefined` en cas d'échec (le service est alors laissé de côté `BACKOFF_MS`). */
  async function attempt<T>(service: Service, url: string, call: () => Promise<T>): Promise<T | undefined> {
    const key = `${service}:${url}`;
    if ((backoff.get(key) ?? 0) > now()) return undefined;
    try {
      return await call();
    } catch {
      backoff.set(key, now() + BACKOFF_MS);
      return undefined;
    }
  }

  const listKey = (service: Service, url: string, what: string) => `${service}:${url}:${what}`;
  const cachedList = <T>(
    service: Service,
    url: string,
    what: string,
    ttl: number,
    load: () => Promise<T>,
    cache = lists,
  ) => attempt(service, url, () => cache.getOrLoad(listKey(service, url, what), ttl, load) as Promise<T>);

  const radarrMovies = (c: ArrServerConfig) =>
    cachedList('radarr', c.url, 'movies', ARR_LIST_TTL_MS, () => listMovies(c));
  const sonarrSeries = (c: ArrServerConfig) =>
    cachedList('sonarr', c.url, 'series', ARR_LIST_TTL_MS, () => listSeries(c));
  const queueOf = (c: ArrServerConfig) => cachedList(c.type, c.url, 'queue', QUEUE_TTL_MS, () => getQueue(c.type, c));

  /**
   * Liste et file de chaque serveur, dans l'ordre de recherche ; `undefined` si l'un d'eux ne répond pas (le cache de
   * cette qualité reste alors tel quel). Aucun serveur : aucun appel.
   */
  async function sourcesOf<T>(
    servers: readonly ArrServerConfig[],
    list: (c: ArrServerConfig) => Promise<T[] | undefined>,
  ): Promise<ArrSource<T>[] | undefined> {
    const loaded = await Promise.all(
      servers.map(async (server) => {
        const [items, queue] = await Promise.all([list(server), queueOf(server)]);
        return items && queue ? { server, items, queue: groupBy(queue, (q) => q.externalId) } : undefined;
      }),
    );
    return loaded.every((source) => source !== undefined) ? loaded : undefined;
  }
  const movieSources = (settings: Settings, is4k: boolean) =>
    sourcesOf(serversOf(settings.servers, 'radarr', is4k), radarrMovies);
  const seriesSources = (settings: Settings, is4k: boolean) =>
    sourcesOf(serversOf(settings.servers, 'sonarr', is4k), sonarrSeries);

  /** Ids TVDB des séries : Sonarr v3 ne donne pas l'id TMDB, il faut alors passer par TMDB (réponse en cache). */
  async function tvdbIdsFor(tmdbIds: number[]): Promise<Map<number, number>> {
    const found = new Map<number, number>();
    let tmdb: TmdbClient;
    try {
      tmdb = deps.tmdb();
    } catch {
      return found; // TMDB non configuré
    }
    const settled = await Promise.allSettled(tmdbIds.map(async (id) => [id, await tmdb.tvdbIdFor(id)] as const));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value[1] !== null) found.set(result.value[0], result.value[1]);
    }
    return found;
  }

  /**
   * Titres trouvés sur le serveur multimédia : recherche ciblée (Emby), ou balayage des bibliothèques gardé
   * `STATUS_TTL_MS` puis filtré (Jellyfin, Plex : un balayage par type et par lot de bibliothèques, pas par page).
   */
  function lookupOn(server: MediaServer, query: MediaItemQuery) {
    const { kind, config, lookup } = server;
    if (lookup.mode === 'search') return attempt(kind, config.url, () => lookup.find(query));
    const libraryIds = query.libraryIds ?? [];
    freshenScan(query.type);
    return cachedList(
      kind,
      config.url,
      `items:${query.type}:${libraryIds.join(',')}`,
      STATUS_TTL_MS,
      () => lookup.list({ type: query.type, libraryIds }),
      scans[query.type],
    ).then((items) => items && matchItems(items, query));
  }

  /** Recherche sur le serveur multimédia, limitée aux bibliothèques suivies du bon type (films : pas les séries, et inversement). */
  async function findOnServer(server: MediaServer, query: Omit<MediaItemQuery, 'libraryIds'>) {
    const { kind, config } = server;
    if (config.libraryIds.length === 0) return lookupOn(server, query);
    const libraries = await cachedList(kind, config.url, 'libraries', STATUS_TTL_MS, () => server.listLibraries());
    if (!libraries) return undefined;
    const other = query.type === 'movie' ? 'tvshows' : 'movies';
    const libraryIds = config.libraryIds.filter((id) => libraries.find((l) => l.id === id)?.type !== other);
    // Aucune bibliothèque suivie de ce type : rien à chercher (une liste vide chercherait dans tout le serveur).
    return libraryIds.length === 0 ? [] : lookupOn(server, { ...query, libraryIds });
  }

  /**
   * Films : statut normal (Emby et serveurs Radarr non 4K), et statut 4K (serveurs Radarr 4K seuls, fichier présent
   * ou en file), chacun calculé à part.
   */
  async function refreshMovies(keys: MediaKey[], settings: Settings): Promise<Update[] | undefined> {
    const { media: server } = settings;
    const tmdbIds = keys.map((k) => k.tmdbId);
    const [found, normal, fourK] = await Promise.all([
      server ? findOnServer(server, { type: 'movie', tmdbIds }) : [],
      movieSources(settings, false),
      movieSources(settings, true),
    ]);
    if (!found || !normal) return undefined;
    const inEmby = new Map(found.map((item) => [item.tmdbId, item.itemId]));
    const facts = (hit: ReturnType<typeof findMovie>) => ({
      hasFile: hit?.movie.hasFile ?? false,
      queue: hit ? progressOf(hit.source.queue.get(hit.movie.radarrId)) : [],
    });
    return keys.map((key) => {
      const hit = findMovie(normal, key.tmdbId);
      const embyItemId = inEmby.get(key.tmdbId);
      const hit4k = fourK && findMovie(fourK, key.tmdbId);
      return {
        key,
        state: libraryState('movie', { inEmby: embyItemId !== undefined, ...facts(hit) }),
        ...(hit && { radarrId: hit.movie.radarrId }),
        ...(embyItemId !== undefined && { embyItemId }),
        ...(fourK && {
          fourK: {
            state: libraryState('movie', { inEmby: false, ...facts(hit4k) }),
            ...(hit4k && { radarrId: hit4k.movie.radarrId }),
          },
        }),
      };
    });
  }

  /**
   * Séries : statut normal (Emby et serveurs Sonarr non 4K, complétés sur la fiche par Emby et TMDB) et statut 4K
   * (serveurs Sonarr 4K seuls : épisodes présents et en file, par saison), chacun calculé à part.
   */
  async function refreshShows(
    keys: MediaKey[],
    settings: Settings,
    cached: Map<string, MediaRow>,
    exact?: ExactSeries,
  ): Promise<Update[] | undefined> {
    const { media: server } = settings;
    const [normal, fourK] = await Promise.all([seriesSources(settings, false), seriesSources(settings, true)]);
    if (!normal) return undefined;
    const allSeries = [...normal, ...(fourK ?? [])].flatMap((source) => source.items);

    // Id TVDB : déjà connu, donné par Sonarr ou par la fiche ; à défaut (Sonarr v3), demandé à TMDB.
    const tvdb = new Map<number, number>();
    for (const { tmdbId } of keys) {
      const known =
        cached.get(keyOf({ type: 'tv', tmdbId }))?.tvdbId ?? allSeries.find((s) => s.tmdbId === tmdbId)?.tvdbId;
      if (known) tvdb.set(tmdbId, known);
    }
    if (exact?.tvdbId) tvdb.set(exact.key.tmdbId, exact.tvdbId);
    const sonarrLacksTmdb = allSeries.some((s) => s.tmdbId === undefined);
    const unresolved = keys.map((k) => k.tmdbId).filter((id) => !tvdb.has(id));
    if (sonarrLacksTmdb && unresolved.length > 0) for (const [k, v] of await tvdbIdsFor(unresolved)) tvdb.set(k, v);

    const found = server
      ? await findOnServer(server, {
          type: 'series',
          tmdbIds: keys.map((k) => k.tmdbId),
          tvdbIds: [...tvdb.values()],
        })
      : [];
    if (!found) return undefined;
    const wanted = new Set(keys.map((k) => k.tmdbId));
    const tmdbOfTvdb = new Map([...tvdb].map(([tmdbId, tvdbId]) => [tvdbId, tmdbId]));
    const embyOf = new Map<number, string>();
    for (const item of found) {
      // Rapprochement par id TMDB, sinon par id TVDB (séries d'Emby sans id TMDB, ou avec un autre).
      const tmdbId =
        item.tmdbId !== undefined && wanted.has(item.tmdbId)
          ? item.tmdbId
          : item.tvdbId !== undefined
            ? tmdbOfTvdb.get(item.tvdbId)
            : undefined;
      if (tmdbId === undefined) continue;
      embyOf.set(tmdbId, item.itemId);
      if (item.tvdbId !== undefined && !tvdb.has(tmdbId)) tvdb.set(tmdbId, item.tvdbId);
    }

    // Fiche d'une série : épisodes présents par saison sur le serveur multimédia (un appel, pour ce seul titre).
    const exactEmbyId = exact && embyOf.get(exact.key.tmdbId);
    const embySeasons =
      server && exactEmbyId
        ? await attempt(server.kind, server.config.url, () => server.seasonAvailability(exactEmbyId))
        : [];
    if (!embySeasons) return undefined;

    const today = new Date(now()).toISOString().slice(0, 10);
    return keys.map((key): Update => {
      const tvdbId = tvdb.get(key.tmdbId);
      const hit = findSeries(normal, key.tmdbId, tvdbId);
      const series = hit?.series;
      const embyItemId = embyOf.get(key.tmdbId);
      const seriesQueue = hit ? (hit.source.queue.get(hit.series.sonarrId) ?? []) : [];
      const isExact = exact !== undefined && keyOf(key) === keyOf(exact.key);

      // Saisons : Sonarr (fichiers / épisodes), complétées sur la fiche par Emby (présents) et TMDB (attendus).
      const numbers = new Set([
        ...(series?.seasons.map((s) => s.seasonNumber) ?? []),
        ...(isExact ? (exact?.seasons.map((s) => s.seasonNumber) ?? []) : []),
        ...(isExact ? embySeasons.map((s) => s.seasonNumber) : []),
      ]);
      const seasonFacts = [...numbers].map((seasonNumber): SeasonFacts => {
        const fromSonarr = series?.seasons.find((s) => s.seasonNumber === seasonNumber);
        const fromEmby = isExact ? embySeasons.find((s) => s.seasonNumber === seasonNumber) : undefined;
        const fromTmdb = isExact ? exact?.seasons.find((s) => s.seasonNumber === seasonNumber) : undefined;
        return {
          seasonNumber,
          present: Math.max(fromSonarr?.episodeFileCount ?? 0, fromEmby?.episodesPresent ?? 0),
          // Épisodes déjà diffusés seulement (une série à jour est complète, une saison annoncée n'attend rien) :
          // Sonarr les compte, à défaut TMDB (`airedEpisodes`).
          expected: fromSonarr
            ? fromSonarr.episodeCount
            : fromTmdb
              ? airedEpisodes(fromTmdb, exact?.lastAired, today)
              : 0,
          queue: progressOf(seriesQueue.filter((q) => q.seasonNumber === seasonNumber)),
        };
      });
      const knowsSeasons = series !== undefined || isExact;
      let state = libraryState('tv', {
        inEmby: embyItemId !== undefined,
        queue: progressOf(seriesQueue),
        ...(knowsSeasons && { seasons: seasonFacts }),
      });
      // Liste d'affiches, série hors Sonarr : « partiel » vient d'un calcul exact (fiche), on ne l'écrase pas.
      if (!knowsSeasons && state?.status === 'available' && cached.get(keyOf(key))?.status === 'partial')
        state = { status: 'partial' };
      return {
        key,
        state,
        ...(tvdbId !== undefined && { tvdbId }),
        ...(series && { sonarrId: series.sonarrId }),
        ...(embyItemId !== undefined && { embyItemId }),
        ...(knowsSeasons && { seasons: seasonRows(seasonFacts) }),
        ...(fourK && { fourK: seriesState4k(findSeries(fourK, key.tmdbId, tvdbId)) }),
      };
    });
  }

  /** Statut 4K d'une série : épisodes de ses saisons sur le serveur 4K qui la connaît, seuls (ni Emby ni TMDB). */
  function seriesState4k(hit: ReturnType<typeof findSeries>): QualityUpdate {
    if (!hit) return { state: null, seasons: [] };
    const queue = hit.source.queue.get(hit.series.sonarrId) ?? [];
    const facts = hit.series.seasons.map(
      (s): SeasonFacts => ({
        seasonNumber: s.seasonNumber,
        present: s.episodeFileCount,
        expected: s.episodeCount,
        queue: progressOf(queue.filter((q) => q.seasonNumber === s.seasonNumber)),
      }),
    );
    return {
      state: libraryState('tv', { inEmby: false, queue: progressOf(queue), seasons: facts }),
      sonarrId: hit.series.sonarrId,
      seasons: seasonRows(facts),
    };
  }

  const isStale = (row: MediaRow | undefined) =>
    !row ||
    now() - row.statusUpdatedAt.getTime() >=
      (row.status === 'downloading' || row.status4k === 'downloading' ? DOWNLOADING_TTL_MS : STATUS_TTL_MS);

  /**
   * Lit le cache, rafraîchit par lot ce qui est périmé ou inconnu (tout, avec `force`), puis relit. `exact` est
   * recalculée quoi qu'il arrive.
   */
  async function resolve(items: readonly MediaKey[], exact?: ExactSeries, force = false) {
    const settings = settingsOf();
    if (!settings.media && settings.servers.length === 0) return undefined;
    const keys = [...new Map(items.map((k) => [keyOf(k), { type: k.type, tmdbId: k.tmdbId }])).values()];
    if (keys.length === 0) return { settings, rows: new Map<string, MediaRow>() };
    const read = () =>
      new Map(
        selectCached(db, keys)
          .all()
          .map((row) => [keyOf(row), row]),
      );
    const cached = read();
    const exactKey = exact && keyOf(exact.key);
    const stale = keys.filter((k) => keyOf(k) !== exactKey && (force || isStale(cached.get(keyOf(k)))));
    if (stale.length === 0 && !exact) return { settings, rows: cached };

    const movies = stale.filter((k) => k.type === 'movie');
    const shows = stale.filter((k) => k.type === 'tv');
    const updates = await Promise.all([
      movies.length > 0 ? refreshMovies(movies, settings) : [],
      shows.length > 0 ? refreshShows(shows, settings, cached) : [],
      // La série de la fiche à part : elle seule paie l'appel des épisodes Emby.
      exact ? refreshShows([exact.key], settings, cached, exact) : [],
    ]);
    writeUpdates(
      db,
      updates.flatMap((u) => u ?? []),
      new Date(now()),
    );
    return { settings, rows: read() };
  }

  /** Id du titre sur ce serveur, d'après sa liste (en cache) : ids TMDB/TVDB, jamais `radarr_id`/`sonarr_id`. */
  async function idOn(server: ArrServerConfig, row: MediaRow): Promise<number | undefined> {
    if (row.type === 'movie') return (await radarrMovies(server))?.find((m) => m.tmdbId === row.tmdbId)?.radarrId;
    const series = await sonarrSeries(server);
    return (
      series?.find((s) => s.tmdbId === row.tmdbId) ??
      (row.tvdbId === null ? undefined : series?.find((s) => s.tvdbId === row.tvdbId))
    )?.sonarrId;
  }

  /**
   * Progression d'un titre (ou d'une saison) en téléchargement dans une qualité : file de chaque serveur de cette
   * qualité qui connaît le titre (listes et files en cache).
   */
  async function progressFor(row: MediaRow, settings: Settings, is4k: boolean, seasonNumber?: number) {
    const items: QueueItem[] = [];
    for (const server of serversOf(settings.servers, arrKindOf(row.type), is4k)) {
      const externalId = await idOn(server, row);
      if (externalId === undefined) continue;
      const queue = (await queueOf(server)) ?? [];
      items.push(
        ...queue.filter(
          (q) => q.externalId === externalId && (seasonNumber === undefined || q.seasonNumber === seasonNumber),
        ),
      );
    }
    return items.length > 0 ? mean(progressOf(items)) : undefined;
  }

  /** Part bibliothèque du statut d'un titre dans une qualité, avec sa progression s'il est en téléchargement. */
  async function libraryOf(row: MediaRow | undefined, settings: Settings, is4k = false): Promise<LibraryState | null> {
    const status = is4k ? row?.status4k : row?.status;
    if (!row || !status) return null;
    const library: LibraryState = { status: status as LibraryStatus };
    if (status === 'downloading') {
      const progress = await progressFor(row, settings, is4k);
      if (progress !== undefined) library.progress = progress;
    }
    return library;
  }

  /**
   * Statut de chaque titre, par clé `type:tmdbId` (absent de la carte = aucun statut) : bibliothèque (si un service
   * est configuré) et demandes, lues chacune en une requête pour tout le lot.
   */
  async function statusesFor(items: readonly MediaKey[], exact?: ExactSeries) {
    const result = new Map<string, TitleAvailability>();
    const resolved = await resolve(items, exact);
    const requested = requestStatesFor(db, items);
    for (const key of new Set([...(resolved?.rows.keys() ?? []), ...requested.keys()])) {
      const row = resolved?.rows.get(key);
      const library = resolved ? await libraryOf(row, resolved.settings) : null;
      const availability = displayStatus(library, requested.get(key) ?? null);
      // Le lien vers Emby suit la bibliothèque, pas le statut affiché : une série partielle déjà demandée se regarde.
      const embyItemId = library?.status === 'available' || library?.status === 'partial' ? row?.embyItemId : null;
      if (availability.status) result.set(key, { ...availability, ...(embyItemId && { embyItemId }) });
    }
    return result;
  }

  /** Copie des titres avec leur statut. */
  async function withStatuses<T extends MediaKey>(items: readonly T[]): Promise<T[]> {
    const statuses = await statusesFor(items);
    return items.map((item) => withStatus(statuses, item));
  }

  /** Saisons d'une série dans une qualité : statut du cache (et progression), part « demandes », épisodes. */
  async function seasonStatuses(
    details: MediaDetails,
    row: MediaRow | undefined,
    settings: Settings,
    is4k: boolean,
  ): Promise<Array<Season['fourK'] & {}>> {
    const table = seasonsTableOf(is4k);
    const rows = row ? db.select().from(table).where(eq(table.mediaId, row.id)).all() : [];
    const byNumber = new Map(rows.map((s) => [s.seasonNumber, s]));
    const requested = row ? seasonRequestStates(db, row.id, is4k) : new Map<number, RequestState>();
    return Promise.all(
      details.seasons.map(async (season) => {
        const cached = byNumber.get(season.seasonNumber);
        const status = cached?.status as LibraryStatus | undefined;
        const progress =
          row && status === 'downloading' ? await progressFor(row, settings, is4k, season.seasonNumber) : undefined;
        const library = status ? { status, ...(progress !== undefined && { progress }) } : null;
        const episodes =
          cached?.episodesPresent != null && cached.episodesExpected != null
            ? { present: cached.episodesPresent, expected: cached.episodesExpected }
            : undefined;
        return { ...(episodes && { episodes }), ...displayStatus(library, requested.get(season.seasonNumber) ?? null) };
      }),
    );
  }

  /**
   * Fiche avec son statut, celui des recommandations et titres similaires (un seul lot), et pour une série le statut
   * de chaque saison. La série est recalculée exactement (saisons Emby) si son cache est périmé ou sans saisons. Quand
   * un serveur 4K du type existe, la fiche et ses saisons portent aussi leur statut 4K (`fourK`).
   */
  async function withDetailsStatus(details: MediaDetails): Promise<MediaDetails> {
    const posters = [...details.recommendations, ...details.similar];
    let exact: ExactSeries | undefined;
    if (details.type === 'tv') {
      const row = selectCached(db, [details]).get();
      if (!row || isStale(row) || (row.status !== null && !row.seasonsComputedAt))
        exact = {
          key: { type: details.type, tmdbId: details.tmdbId },
          seasons: details.seasons,
          tvdbId: details.externalIds.tvdb,
          lastAired: details.lastAired,
        };
    }
    const statuses = await statusesFor([details, ...posters], exact);

    const settings = settingsOf();
    const row = selectCached(db, [details]).get();
    const has4k = serversOf(settings.servers, arrKindOf(details.type), true).length > 0;
    const fourK = has4k
      ? displayStatus(
          await libraryOf(row, settings, true),
          requestStatesFor(db, [details], true).get(keyOf(details)) ?? null,
        )
      : undefined;

    let seasonList = details.seasons;
    if (details.type === 'tv') {
      const normal = await seasonStatuses(details, row, settings, false);
      const fourKSeasons = has4k ? await seasonStatuses(details, row, settings, true) : [];
      seasonList = details.seasons.map((season, i) => ({
        ...season,
        ...normal[i],
        ...(has4k && { fourK: fourKSeasons[i] }),
      }));
    }
    return {
      ...withStatus(statuses, details),
      ...(fourK && { fourK }),
      seasons: seasonList,
      recommendations: details.recommendations.map((item) => withStatus(statuses, item)),
      similar: details.similar.map((item) => withStatus(statuses, item)),
    };
  }

  /**
   * Rangée « Ajoutés récemment dans … » : derniers films et séries des bibliothèques suivies que ce membre peut voir sur
   * le serveur (Emby, Jellyfin : accès aux bibliothèques et contrôle parental, admins compris ; Plex : les mêmes pour
   * tous, voir DECISIONS.md), gardés par membre, résumés par TMDB (un appel en cache par titre). `null` (rangée omise)
   * si rien n'est configuré ou si le serveur ne répond pas : comme pour les statuts, une panne n'est retentée qu'après
   * `BACKOFF_MS`, Découvrir n'attend pas un serveur muet à chaque visite.
   */
  async function recentlyAdded(userId: string): Promise<MediaSummary[] | null> {
    const server = mediaServers.current();
    if (!server) return null;
    const { libraryIds, url } = server.config;
    const tmdb = deps.tmdb();
    const latest = await cachedList(
      server.kind,
      url,
      `latest:${userId}:${libraryIds.join(',')}`,
      LATEST_TTL_MS,
      () => server.latestItems({ libraryIds, limit: LATEST_LIMIT, userId }),
      latestLists,
    );
    if (!latest) return null;
    const settled = await Promise.allSettled(latest.map(({ type, tmdbId }) => tmdb.summary(type, tmdbId)));
    return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  }

  /** Derniers ajouts du serveur, toutes bibliothèques suivies (balayage léger) ; aucun sans serveur, erreur propagée. */
  async function latestOnServer(limit: number) {
    const server = mediaServers.current();
    return server ? server.latestItems({ libraryIds: server.config.libraryIds, limit }) : [];
  }

  /**
   * De quoi bâtir « Regarder dans … » : type et id du serveur (gardé une heure) et, pour Emby et Jellyfin, l'adresse
   * publique réglée (Plex passe par app.plex.tv). `null` sans adresse publique (Emby, Jellyfin) ou si le serveur ne
   * répond pas : pas de lien, jamais d'erreur.
   */
  async function watchLink(): Promise<WatchLink | null> {
    const server = mediaServers.current();
    if (!server) return null;
    const { kind, config } = server;
    if (kind !== 'plex' && !config.publicUrl) return null;
    const serverId = await cachedList(kind, config.url, 'server-id', SERVER_ID_TTL_MS, () => server.serverId());
    return serverId ? { kind, serverId, publicUrl: kind === 'plex' ? null : config.publicUrl } : null;
  }

  // --- Synchronisation (webhooks, balayages) ---

  /**
   * Oublie la liste et la file d'un serveur qui vient de signaler un changement (tous ceux du type sans `serverId`) :
   * le prochain calcul les relit.
   */
  function forgetLists(kind: ArrKind, serverId?: number) {
    for (const server of settingsOf().servers)
      if (server.type === kind && (serverId === undefined || server.id === serverId))
        for (const what of [kind === 'radarr' ? 'movies' : 'series', 'queue'])
          lists.delete(listKey(kind, server.url, what));
  }

  /**
   * Recalcule ces titres tout de suite, sans attendre la fin de vie de leur cache (webhook, balayage) ; `forget` :
   * liste et file de ce type de serveur (de ce seul serveur avec `serverId`) relues d'abord, et balayage du serveur
   * multimédia de ce type (films pour Radarr, séries pour Sonarr) déclaré périmé : le fichier annoncé vient d'y arriver.
   * Seuls ces titres sont recalculés, rien d'autre.
   */
  async function refresh(
    items: readonly MediaKey[],
    { forget, serverId }: { forget?: ArrKind; serverId?: number } = {},
  ) {
    if (forget) {
      forgetLists(forget, serverId);
      staleScans.add(forget === 'radarr' ? 'movie' : 'series');
    }
    await resolve(items, undefined, true);
  }

  /**
   * Grab d'un serveur connu : le titre (et les saisons concernées) passe « en téléchargement » dans la qualité du
   * serveur sans attendre la file, sauf ce qui est déjà disponible (mise à niveau d'un fichier). Écriture directe du
   * cache, que le calcul complet remplace dès sa fin de vie (`DOWNLOADING_TTL_MS`) ; la file du serveur est relue pour
   * la progression.
   */
  function markDownloading(
    server: Pick<ArrServerConfig, 'id' | 'type' | 'is4k'>,
    mediaId: number,
    seasonNumbers: readonly number[] = [],
  ) {
    forgetLists(server.type, server.id);
    const at = new Date(now());
    const status = server.is4k ? media.status4k : media.status;
    const table = seasonsTableOf(server.is4k);
    db.transaction((tx) => {
      tx.update(media)
        .set(
          server.is4k
            ? { status4k: 'downloading', statusUpdatedAt: at }
            : { status: 'downloading', statusUpdatedAt: at },
        )
        .where(and(eq(media.id, mediaId), sql`${status} IS NOT 'available'`))
        .run();
      if (seasonNumbers.length > 0)
        tx.insert(table)
          .values(seasonNumbers.map((seasonNumber) => ({ mediaId, seasonNumber, status: 'downloading' as const })))
          .onConflictDoUpdate({
            target: [table.mediaId, table.seasonNumber],
            set: { status: 'downloading' },
            setWhere: sql`${table.status} <> 'available'`,
          })
          .run();
    });
  }

  return {
    statusesFor,
    withStatuses,
    withDetailsStatus,
    recentlyAdded,
    latestOnServer,
    watchLink,
    refresh,
    markDownloading,
  };
}

export type AvailabilityService = ReturnType<typeof createAvailability>;
