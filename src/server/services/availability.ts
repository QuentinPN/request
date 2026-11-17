import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  keyOf,
  type MediaDetails,
  type MediaKey,
  type MediaSummary,
  type MediaType,
  type Season,
} from '../../shared/media.ts';
import type { Setting } from '../../shared/settings.ts';
import type { Availability, LibraryStatus, MediaStatus, RequestStatus } from '../../shared/status.ts';
import type { Data, Db } from '../db/index.ts';
import { media, requestSeasons, requests, seasons } from '../db/schema.ts';
import { type ArrKind, arrKindOf, getQueue, type QueueItem } from '../integrations/arr.ts';
import { findEmbyItems, getEmbySeasonAvailability, latestEmbyItems, listEmbyLibraries } from '../integrations/emby.ts';
import { listMovies } from '../integrations/radarr.ts';
import { listSeries } from '../integrations/sonarr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { TtlLru } from '../lib/lru.ts';
import { markAvailable } from './requests.ts';
import { getSetting } from './settings.ts';

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
export const withStatus = <T extends MediaKey>(statuses: ReadonlyMap<string, Availability>, item: T): T => ({
  ...item,
  ...statuses.get(keyOf(item)),
});

// --- Cache en base ---

type MediaRow = typeof media.$inferSelect;

/** `(type, tmdb_id) IN (VALUES …)` : lecture par lot servie par l'index unique `(type, tmdb_id)` de `media`. */
function mediaKeysIn(keys: readonly MediaKey[]) {
  const values = sql.join(
    keys.map(({ type, tmdbId }) => sql`(${type}, ${tmdbId})`),
    sql`, `,
  );
  return sql`(${media.type}, ${media.tmdbId}) IN (VALUES ${values})`;
}

/** Lecture par lot des statuts d'une page d'affiches, en une requête servie par l'index unique `(type, tmdb_id)`. */
export function selectCached(db: Db, keys: readonly MediaKey[]) {
  return db.select().from(media).where(mediaKeysIn(keys));
}

/** Part « demandes » de chaque titre (clé `type:tmdbId`), en une requête pour toute une page d'affiches. */
export function requestStatesFor(db: Db, keys: readonly MediaKey[]): Map<string, RequestState> {
  if (keys.length === 0) return new Map();
  const rows = db
    .select({ type: media.type, tmdbId: media.tmdbId, status: requests.status })
    .from(media)
    .innerJoin(requests, eq(requests.mediaId, media.id))
    .where(and(mediaKeysIn(keys), inArray(requests.status, shownRequestStatuses)))
    .all();
  return strongestByKey(rows.map((row) => ({ key: keyOf(row), status: row.status })));
}

/** Part « demandes » de chaque saison d'une série (numéro de saison → état). */
function seasonRequestStates(db: Db, mediaId: number): Map<number, RequestState> {
  const rows = db
    .select({ key: requestSeasons.seasonNumber, status: requests.status })
    .from(requests)
    .innerJoin(requestSeasons, eq(requestSeasons.requestId, requests.id))
    .where(and(eq(requests.mediaId, mediaId), inArray(requests.status, shownRequestStatuses)))
    .all();
  return strongestByKey(rows);
}

interface Update {
  key: MediaKey;
  state: LibraryState | null;
  tvdbId?: number;
  radarrId?: number;
  sonarrId?: number;
  embyItemId?: string;
  /** Statut par saison ; absent = saisons inconnues, les lignes existantes sont gardées. */
  seasons?: Array<{ seasonNumber: number; status: LibraryStatus }>;
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
      if (!u.seasons) continue;
      tx.delete(seasons).where(eq(seasons.mediaId, row.id)).run();
      if (u.seasons.length > 0)
        tx.insert(seasons)
          .values(u.seasons.map((s) => ({ mediaId: row.id, ...s })))
          .run();
    }
    markAvailable(tx, written, now);
  });
}

// --- Service ---

type Service = 'emby' | 'radarr' | 'sonarr';

/** Série de la fiche, recalculée exactement : ses saisons TMDB et son id TVDB complètent Emby et Sonarr. */
interface ExactSeries {
  key: MediaKey;
  seasons: readonly Season[];
  tvdbId: number | null;
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
export function createAvailability(data: Data, deps: { tmdb: () => TmdbClient; now?: () => number }) {
  const { db, cryptoKey } = data;
  const now = deps.now ?? Date.now;
  const lists = new TtlLru({ maxEntries: 32 });
  /** Clé `service:url` : changer l'adresse d'un service (réglages) lève tout de suite sa mise à l'écart. */
  const backoff = new Map<string, number>();

  const settingsOf = () => ({
    emby: getSetting(db, cryptoKey, 'emby'),
    radarr: getSetting(db, cryptoKey, 'radarr'),
    sonarr: getSetting(db, cryptoKey, 'sonarr'),
  });
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
  const cachedList = <T>(service: Service, url: string, what: string, ttl: number, load: () => Promise<T>) =>
    attempt(service, url, () => lists.getOrLoad(listKey(service, url, what), ttl, load) as Promise<T>);

  const radarrMovies = (c: Setting<'radarr'>) =>
    cachedList('radarr', c.url, 'movies', ARR_LIST_TTL_MS, () => listMovies(c));
  const sonarrSeries = (c: Setting<'sonarr'>) =>
    cachedList('sonarr', c.url, 'series', ARR_LIST_TTL_MS, () => listSeries(c));
  const queueOf = (kind: 'radarr' | 'sonarr', c: { url: string; apiKey: string }) =>
    cachedList(kind, c.url, 'queue', QUEUE_TTL_MS, () => getQueue(kind, c));

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

  /** Recherche dans Emby, limitée aux bibliothèques suivies du bon type (films : pas les séries, et inversement). */
  async function findInEmby(emby: Setting<'emby'>, query: Omit<Parameters<typeof findEmbyItems>[1], 'libraryIds'>) {
    if (emby.libraryIds.length === 0) return attempt('emby', emby.url, () => findEmbyItems(emby, query));
    const libraries = await cachedList('emby', emby.url, 'libraries', STATUS_TTL_MS, () => listEmbyLibraries(emby));
    if (!libraries) return undefined;
    const other = query.type === 'movie' ? 'tvshows' : 'movies';
    const libraryIds = emby.libraryIds.filter((id) => libraries.find((l) => l.id === id)?.type !== other);
    // Aucune bibliothèque suivie de ce type : rien à chercher (une liste vide chercherait dans tout le serveur).
    return libraryIds.length === 0
      ? []
      : attempt('emby', emby.url, () => findEmbyItems(emby, { ...query, libraryIds }));
  }

  async function refreshMovies(keys: MediaKey[], settings: Settings): Promise<Update[] | undefined> {
    const { emby, radarr } = settings;
    const tmdbIds = keys.map((k) => k.tmdbId);
    const [found, movies, queue] = await Promise.all([
      emby ? findInEmby(emby, { type: 'movie', tmdbIds }) : [],
      radarr ? radarrMovies(radarr) : [],
      radarr ? queueOf('radarr', radarr) : [],
    ]);
    if (!found || !movies || !queue) return undefined;
    const inEmby = new Map(found.map((item) => [item.tmdbId, item.embyId]));
    const byTmdb = new Map(movies.map((m) => [m.tmdbId, m]));
    const queued = groupBy(queue, (q) => q.externalId);
    return keys.map((key) => {
      const movie = byTmdb.get(key.tmdbId);
      const embyItemId = inEmby.get(key.tmdbId);
      const state = libraryState('movie', {
        inEmby: embyItemId !== undefined,
        hasFile: movie?.hasFile ?? false,
        queue: movie ? progressOf(queued.get(movie.radarrId)) : [],
      });
      return {
        key,
        state,
        ...(movie && { radarrId: movie.radarrId }),
        ...(embyItemId !== undefined && { embyItemId }),
      };
    });
  }

  async function refreshShows(
    keys: MediaKey[],
    settings: Settings,
    cached: Map<string, MediaRow>,
    exact?: ExactSeries,
  ): Promise<Update[] | undefined> {
    const { emby, sonarr } = settings;
    const [allSeries, queue] = await Promise.all([
      sonarr ? sonarrSeries(sonarr) : [],
      sonarr ? queueOf('sonarr', sonarr) : [],
    ]);
    if (!allSeries || !queue) return undefined;
    const byTmdb = new Map(allSeries.flatMap((s) => (s.tmdbId ? [[s.tmdbId, s] as const] : [])));
    const byTvdb = new Map(allSeries.map((s) => [s.tvdbId, s]));

    // Id TVDB : déjà connu, donné par Sonarr ou par la fiche ; à défaut (Sonarr v3), demandé à TMDB.
    const tvdb = new Map<number, number>();
    for (const { tmdbId } of keys) {
      const known = cached.get(keyOf({ type: 'tv', tmdbId }))?.tvdbId ?? byTmdb.get(tmdbId)?.tvdbId;
      if (known) tvdb.set(tmdbId, known);
    }
    if (exact?.tvdbId) tvdb.set(exact.key.tmdbId, exact.tvdbId);
    const sonarrLacksTmdb = allSeries.some((s) => s.tmdbId === undefined);
    const unresolved = keys.map((k) => k.tmdbId).filter((id) => !tvdb.has(id));
    if (sonarrLacksTmdb && unresolved.length > 0) for (const [k, v] of await tvdbIdsFor(unresolved)) tvdb.set(k, v);

    const found = emby
      ? await findInEmby(emby, { type: 'series', tmdbIds: keys.map((k) => k.tmdbId), tvdbIds: [...tvdb.values()] })
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
      embyOf.set(tmdbId, item.embyId);
      if (item.tvdbId !== undefined && !tvdb.has(tmdbId)) tvdb.set(tmdbId, item.tvdbId);
    }

    // Fiche d'une série : épisodes présents par saison dans Emby (un appel, pour ce seul titre).
    const exactEmbyId = exact && embyOf.get(exact.key.tmdbId);
    const embySeasons =
      emby && exactEmbyId ? await attempt('emby', emby.url, () => getEmbySeasonAvailability(emby, exactEmbyId)) : [];
    if (!embySeasons) return undefined;

    const queued = groupBy(queue, (q) => q.externalId);
    return keys.map((key): Update => {
      const tvdbId = tvdb.get(key.tmdbId);
      const series = byTmdb.get(key.tmdbId) ?? (tvdbId !== undefined ? byTvdb.get(tvdbId) : undefined);
      const embyItemId = embyOf.get(key.tmdbId);
      const seriesQueue = series ? (queued.get(series.sonarrId) ?? []) : [];
      const isExact = exact !== undefined && keyOf(key) === keyOf(exact.key);

      // Saisons : Sonarr (fichiers / épisodes), complétées sur la fiche par Emby (présents) et TMDB (attendus).
      const numbers = new Set([
        ...(series?.seasons.map((s) => s.seasonNumber) ?? []),
        ...(isExact ? (exact?.seasons.map((s) => s.seasonNumber) ?? []) : []),
        ...(isExact ? embySeasons.map((s) => s.seasonNumber) : []),
      ]);
      const today = new Date(now()).toISOString().slice(0, 10);
      const seasonFacts = [...numbers].map((seasonNumber): SeasonFacts => {
        const fromSonarr = series?.seasons.find((s) => s.seasonNumber === seasonNumber);
        const fromEmby = isExact ? embySeasons.find((s) => s.seasonNumber === seasonNumber) : undefined;
        const fromTmdb = isExact ? exact?.seasons.find((s) => s.seasonNumber === seasonNumber) : undefined;
        return {
          seasonNumber,
          present: Math.max(fromSonarr?.episodeFileCount ?? 0, fromEmby?.episodesPresent ?? 0),
          // Épisodes déjà diffusés seulement (une série à jour est complète, une saison annoncée n'attend rien) :
          // Sonarr les compte ; sur TMDB, une saison compte une fois sa date de diffusion passée.
          expected: fromSonarr
            ? fromSonarr.episodeCount
            : fromTmdb?.airDate && fromTmdb.airDate <= today
              ? fromTmdb.episodeCount
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
        ...(knowsSeasons && {
          seasons: seasonFacts.flatMap((s) => {
            const season = seasonState(s);
            return season ? [{ seasonNumber: s.seasonNumber, status: season.status }] : [];
          }),
        }),
      };
    });
  }

  const isStale = (row: MediaRow | undefined) =>
    !row ||
    now() - row.statusUpdatedAt.getTime() >= (row.status === 'downloading' ? DOWNLOADING_TTL_MS : STATUS_TTL_MS);

  /**
   * Lit le cache, rafraîchit par lot ce qui est périmé ou inconnu (tout, avec `force`), puis relit. `exact` est
   * recalculée quoi qu'il arrive.
   */
  async function resolve(items: readonly MediaKey[], exact?: ExactSeries, force = false) {
    const settings = settingsOf();
    if (!settings.emby && !settings.radarr && !settings.sonarr) return undefined;
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

  /** Progression d'un titre (ou d'une saison) en téléchargement, lue dans la file (en cache). */
  async function progressFor(row: MediaRow, settings: Settings, seasonNumber?: number) {
    const kind = arrKindOf(row.type);
    const config = settings[kind];
    const externalId = row.type === 'movie' ? row.radarrId : row.sonarrId;
    if (!config || externalId === null) return undefined;
    const queue = (await queueOf(kind, config)) ?? [];
    const items = queue.filter(
      (q) => q.externalId === externalId && (seasonNumber === undefined || q.seasonNumber === seasonNumber),
    );
    return items.length > 0 ? mean(progressOf(items)) : undefined;
  }

  async function libraryOf(row: MediaRow | undefined, settings: Settings): Promise<LibraryState | null> {
    if (!row?.status) return null;
    const library: LibraryState = { status: row.status as LibraryStatus };
    if (row.status === 'downloading') {
      const progress = await progressFor(row, settings);
      if (progress !== undefined) library.progress = progress;
    }
    return library;
  }

  /**
   * Statut de chaque titre, par clé `type:tmdbId` (absent de la carte = aucun statut) : bibliothèque (si un service
   * est configuré) et demandes, lues chacune en une requête pour tout le lot.
   */
  async function statusesFor(items: readonly MediaKey[], exact?: ExactSeries) {
    const result = new Map<string, Availability>();
    const resolved = await resolve(items, exact);
    const requested = requestStatesFor(db, items);
    for (const key of new Set([...(resolved?.rows.keys() ?? []), ...requested.keys()])) {
      const library = resolved ? await libraryOf(resolved.rows.get(key), resolved.settings) : null;
      const availability = displayStatus(library, requested.get(key) ?? null);
      if (availability.status) result.set(key, availability);
    }
    return result;
  }

  /** Copie des titres avec leur statut. */
  async function withStatuses<T extends MediaKey>(items: readonly T[]): Promise<T[]> {
    const statuses = await statusesFor(items);
    return items.map((item) => withStatus(statuses, item));
  }

  /**
   * Fiche avec son statut, celui des recommandations et titres similaires (un seul lot), et pour une série le statut
   * de chaque saison. La série est recalculée exactement (saisons Emby) si son cache est périmé ou sans saisons.
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
        };
    }
    const statuses = await statusesFor([details, ...posters], exact);

    let seasonList = details.seasons;
    if (details.type === 'tv') {
      const settings = settingsOf();
      const row = selectCached(db, [details]).get();
      const rows = row ? db.select().from(seasons).where(eq(seasons.mediaId, row.id)).all() : [];
      const byNumber = new Map(rows.map((s) => [s.seasonNumber, s.status as LibraryStatus]));
      const requested = row ? seasonRequestStates(db, row.id) : new Map<number, RequestState>();
      seasonList = await Promise.all(
        details.seasons.map(async (season) => {
          const status = byNumber.get(season.seasonNumber);
          const progress =
            row && status === 'downloading' ? await progressFor(row, settings, season.seasonNumber) : undefined;
          const library = status ? { status, ...(progress !== undefined && { progress }) } : null;
          return { ...season, ...displayStatus(library, requested.get(season.seasonNumber) ?? null) };
        }),
      );
    }
    return {
      ...withStatus(statuses, details),
      seasons: seasonList,
      recommendations: details.recommendations.map((item) => withStatus(statuses, item)),
      similar: details.similar.map((item) => withStatus(statuses, item)),
    };
  }

  /**
   * Rangée « Ajoutés récemment dans Emby » : derniers films et séries des bibliothèques suivies, résumés par TMDB
   * (un appel en cache par titre). `null` (rangée omise) si Emby n'est pas configuré ou ne répond pas : comme pour les
   * statuts, une panne n'est retentée qu'après `BACKOFF_MS`, Découvrir n'attend pas un Emby muet à chaque visite.
   */
  async function recentlyAdded(): Promise<MediaSummary[] | null> {
    const emby = getSetting(db, cryptoKey, 'emby');
    if (!emby) return null;
    const tmdb = deps.tmdb();
    const latest = await cachedList('emby', emby.url, `latest:${emby.libraryIds.join(',')}`, LATEST_TTL_MS, () =>
      latestEmbyItems(emby, { libraryIds: emby.libraryIds, limit: LATEST_LIMIT }),
    );
    if (!latest) return null;
    const settled = await Promise.allSettled(latest.map(({ type, tmdbId }) => tmdb.summary(type, tmdbId)));
    return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  }

  // --- Synchronisation (webhooks, balayages) ---

  /** Oublie la liste et la file d'un service qui vient de signaler un changement : le prochain calcul les relit. */
  function forgetLists(kind: ArrKind) {
    const config = settingsOf()[kind];
    if (!config) return;
    for (const what of [kind === 'radarr' ? 'movies' : 'series', 'queue'])
      lists.delete(listKey(kind, config.url, what));
  }

  /**
   * Recalcule ces titres tout de suite, sans attendre la fin de vie de leur cache (webhook, balayage) ; `forget` :
   * liste et file de ce service relues d'abord. Seuls ces titres sont recalculés, rien d'autre.
   */
  async function refresh(items: readonly MediaKey[], { forget }: { forget?: ArrKind } = {}) {
    if (forget) forgetLists(forget);
    await resolve(items, undefined, true);
  }

  /**
   * Grab : le titre (et les saisons concernées) passe « en téléchargement » sans attendre la file, sauf ce qui est déjà
   * disponible (mise à niveau d'un fichier). Écriture directe du cache, que le calcul complet remplace dès sa fin de vie
   * (`DOWNLOADING_TTL_MS`) ; la file du service est relue pour la progression.
   */
  function markDownloading(kind: ArrKind, mediaId: number, seasonNumbers: readonly number[] = []) {
    forgetLists(kind);
    const at = new Date(now());
    const notAvailable = sql`${media.status} IS NOT 'available'`;
    db.transaction((tx) => {
      tx.update(media)
        .set({ status: 'downloading', statusUpdatedAt: at })
        .where(and(eq(media.id, mediaId), notAvailable))
        .run();
      if (seasonNumbers.length > 0)
        tx.insert(seasons)
          .values(seasonNumbers.map((seasonNumber) => ({ mediaId, seasonNumber, status: 'downloading' as const })))
          .onConflictDoUpdate({
            target: [seasons.mediaId, seasons.seasonNumber],
            set: { status: 'downloading' },
            setWhere: sql`${seasons.status} <> 'available'`,
          })
          .run();
    });
  }

  return { statusesFor, withStatuses, withDetailsStatus, recentlyAdded, refresh, markDownloading };
}

export type AvailabilityService = ReturnType<typeof createAvailability>;
