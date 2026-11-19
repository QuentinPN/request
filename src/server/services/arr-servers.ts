import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ArrKind, ArrServer, arrServerInputSchema } from '../../shared/arr-servers.ts';
import { arrKindLabels, arrKinds } from '../../shared/arr-servers.ts';
import {
  DEFAULT_MINIMUM_AVAILABILITY,
  DEFAULT_SERIES_TYPE,
  type MinimumAvailability,
  type SeriesType,
} from '../../shared/settings.ts';
import { activeRequestStatuses } from '../../shared/status.ts';
import { decrypt, encrypt } from '../crypto.ts';
import type { Data, Db } from '../db/index.ts';
import { arrServers, requests, settings } from '../db/schema.ts';
import { type ArrOptions, listArrOptions } from '../integrations/arr.ts';
import { HttpError } from '../lib/api-errors.ts';
import { TtlLru } from '../lib/lru.ts';

export type ArrServerValues = z.output<typeof arrServerInputSchema>;
type Row = typeof arrServers.$inferSelect;
type Writer = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'run'>;

/** Serveur Radarr/Sonarr avec sa clé déchiffrée : usage serveur seulement, jamais envoyé au navigateur. */
export interface ArrServerConfig extends Omit<ArrServer, 'apiKey'> {
  apiKey: string;
}

const NOT_FOUND = 'Serveur introuvable';

const toConfig = (cryptoKey: Buffer, { apiKey, createdAt: _c, updatedAt: _u, ...row }: Row): ArrServerConfig => ({
  ...row,
  apiKey: decrypt(cryptoKey, apiKey),
});

/** Version envoyable au navigateur (propriétaire) : la clé devient `{ set }`. */
export const maskArrServer = ({ apiKey, ...server }: ArrServerConfig): ArrServer => ({
  ...server,
  apiKey: { set: apiKey !== '' },
});

/**
 * Tous les serveurs, par type et qualité, le serveur par défaut d'abord puis du plus ancien au plus récent : l'ordre
 * dans lequel un titre est cherché sur plusieurs serveurs (le premier qui le connaît l'emporte).
 */
export function listArrServers({ db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>): ArrServerConfig[] {
  return db
    .select()
    .from(arrServers)
    .orderBy(asc(arrServers.type), asc(arrServers.is4k), desc(arrServers.isDefault), asc(arrServers.id))
    .all()
    .map((row) => toConfig(cryptoKey, row));
}

/** Serveurs d'un type et d'une qualité, dans l'ordre de `listArrServers`. */
export const serversOf = (all: readonly ArrServerConfig[], kind: ArrKind, is4k: boolean) =>
  all.filter((s) => s.type === kind && s.is4k === is4k);

export function getArrServer({ db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>, id: number): ArrServerConfig | null {
  const row = db.select().from(arrServers).where(eq(arrServers.id, id)).get();
  return row ? toConfig(cryptoKey, row) : null;
}

/** Id du serveur par défaut d'un type et d'une qualité, sans déchiffrer de clé (import Seerr). */
export const defaultArrServerId = (db: Db, kind: ArrKind, is4k: boolean): number | null =>
  db
    .select({ id: arrServers.id })
    .from(arrServers)
    .where(and(eq(arrServers.type, kind), eq(arrServers.is4k, is4k), eq(arrServers.isDefault, true)))
    .get()?.id ?? null;

/** Un serveur de ce type existe-t-il (section de l'assistant faite) ? */
export const hasArrServer = (db: Db, kind: ArrKind, is4k?: boolean) =>
  db
    .select({ id: arrServers.id })
    .from(arrServers)
    .where(and(eq(arrServers.type, kind), is4k === undefined ? undefined : eq(arrServers.is4k, is4k)))
    .get() !== undefined;

const ARR_OPTIONS_TTL_MS = 60_000;
const ARR_OPTIONS_MAX_SERVERS = 32;
/** Par base (un serveur d'une autre base, en test, a le même id) : profils et dossiers par id de serveur. */
const arrOptionsCaches = new WeakMap<Db, TtlLru<ArrOptions>>();

function arrOptionsCache(db: Db) {
  const cache = arrOptionsCaches.get(db) ?? new TtlLru<ArrOptions>({ maxEntries: ARR_OPTIONS_MAX_SERVERS });
  arrOptionsCaches.set(db, cache);
  return cache;
}

/**
 * Profils et dossiers d'un serveur, gardés une minute ; des demandes simultanées partagent un seul appel (file
 * d'approbation : une fenêtre d'options par demande). Oubliés quand le serveur change ou qu'un envoi y échoue.
 */
export const arrOptionsOf = (db: Db, server: ArrServerConfig) =>
  arrOptionsCache(db).getOrLoad(String(server.id), ARR_OPTIONS_TTL_MS, () => listArrOptions(server.type, server));

export const forgetArrOptions = (db: Db, id: number) => arrOptionsCache(db).delete(String(id));

/** Champs propres au type : disponibilité minimale pour Radarr, type de série et profil de langue pour Sonarr. */
function typeColumnsOf(
  kind: ArrKind,
  v: {
    minimumAvailability?: MinimumAvailability | null;
    seriesType?: SeriesType | null;
    languageProfileId?: number | null;
  },
) {
  const radarr = kind === 'radarr';
  return {
    minimumAvailability: radarr ? (v.minimumAvailability ?? DEFAULT_MINIMUM_AVAILABILITY) : null,
    seriesType: radarr ? null : (v.seriesType ?? DEFAULT_SERIES_TYPE),
    languageProfileId: radarr ? null : (v.languageProfileId ?? null),
  };
}

/** Réglages anime (Sonarr seulement, comme chez Seerr) : vides pour Radarr. */
function animeColumnsOf(kind: ArrKind, v: ArrServerValues) {
  const sonarr = kind === 'sonarr';
  return {
    animeQualityProfileId: sonarr ? v.animeQualityProfileId : null,
    animeRootFolderPath: sonarr ? v.animeRootFolderPath : null,
    animeSeriesType: sonarr ? v.animeSeriesType : null,
    animeLanguageProfileId: sonarr ? v.animeLanguageProfileId : null,
    animeTags: sonarr ? v.animeTags : [],
  };
}

function columnsOf(cryptoKey: Buffer, v: ArrServerValues) {
  return {
    type: v.type,
    name: v.name,
    url: v.url,
    apiKey: encrypt(cryptoKey, v.apiKey),
    is4k: v.is4k,
    isDefault: v.isDefault,
    qualityProfileId: v.qualityProfileId,
    rootFolderPath: v.rootFolderPath,
    ...typeColumnsOf(v.type, v),
    ...animeColumnsOf(v.type, v),
    tags: v.tags,
    tagRequester: v.tagRequester,
    searchOnAdd: v.searchOnAdd,
    externalUrl: v.externalUrl,
  };
}

/**
 * Un serveur par défaut par couple (type, 4K) dès qu'il y a un serveur : à défaut, le plus ancien. Appelé après chaque
 * écriture (premier serveur, suppression du défaut, passage en 4K ou retour).
 */
function ensureDefaults(tx: Writer) {
  tx.run(sql`
    update ${arrServers} set is_default = 1
    where id in (select min(id) from ${arrServers} group by type, is_4k having max(is_default) = 0)`);
}

/** Retire le défaut des autres serveurs du couple avant d'en poser un (index unique partiel). */
function clearDefault(tx: Writer, kind: ArrKind, is4k: boolean, except?: number) {
  tx.update(arrServers)
    .set({ isDefault: false })
    .where(
      and(
        eq(arrServers.type, kind),
        eq(arrServers.is4k, is4k),
        except === undefined ? undefined : ne(arrServers.id, except),
      ),
    )
    .run();
}

/** Demandes encore suivies (en attente, approuvées, envoyées, en échec) qui visent ce serveur. */
const hasActiveRequests = (tx: Writer, serverId: number) =>
  tx
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.serverId, serverId), inArray(requests.status, [...activeRequestStatuses])))
    .get() !== undefined;

/**
 * Crée (`id` absent) ou modifie un serveur, déjà validé et testé ; le défaut de son couple suit. Le type et la 4K d'un
 * serveur visé par des demandes en cours ne changent pas (409) : leur suivi et leur envoi dépendent de ce couple.
 */
export function saveArrServer(data: Pick<Data, 'db' | 'cryptoKey'>, values: ArrServerValues, id?: number) {
  const { db, cryptoKey } = data;
  const savedId = db.transaction((tx) => {
    if (id !== undefined) {
      const current = tx.select().from(arrServers).where(eq(arrServers.id, id)).get();
      if (!current) throw new HttpError(404, NOT_FOUND);
      if ((current.type !== values.type || current.is4k !== values.is4k) && hasActiveRequests(tx, id))
        throw new HttpError(
          409,
          'Des demandes en cours visent ce serveur : son type et sa 4K ne peuvent pas changer. Ajoutez plutôt un autre serveur.',
        );
    }
    if (values.isDefault) clearDefault(tx, values.type, values.is4k, id);
    const columns = columnsOf(cryptoKey, values);
    const row =
      id === undefined
        ? tx.insert(arrServers).values(columns).returning({ id: arrServers.id }).get()
        : tx
            .update(arrServers)
            .set({ ...columns, updatedAt: new Date() })
            .where(eq(arrServers.id, id))
            .returning({ id: arrServers.id })
            .get();
    if (!row) throw new HttpError(404, NOT_FOUND);
    ensureDefaults(tx);
    return row.id;
  });
  forgetArrOptions(db, savedId);
  return getArrServer(data, savedId) as ArrServerConfig;
}

/**
 * Supprime un serveur. Ses demandes pas encore envoyées (en attente, approuvées, en échec) reviennent au serveur par
 * défaut avec ses réglages : profil et dossier, propres au serveur supprimé, sont effacés (une relance les reprend du
 * défaut). Les demandes envoyées gardent leur historique ; `server_id` passe à `NULL` (clé étrangère). Le dernier
 * serveur non 4K d'un type ne se supprime pas (409) : l'installation redeviendrait incomplète.
 */
export function deleteArrServer(db: Db, id: number) {
  db.transaction((tx) => {
    const current = tx.select().from(arrServers).where(eq(arrServers.id, id)).get();
    if (!current) throw new HttpError(404, NOT_FOUND);
    const label = arrKindLabels[current.type];
    if (
      !current.is4k &&
      !tx
        .select({ id: arrServers.id })
        .from(arrServers)
        .where(and(eq(arrServers.type, current.type), eq(arrServers.is4k, false), ne(arrServers.id, id)))
        .get()
    )
      throw new HttpError(
        409,
        `Gardez au moins un serveur ${label} : ajoutez-en un autre avant de supprimer celui-ci.`,
      );
    tx.update(requests)
      .set({ serverId: null, qualityProfileId: null, rootFolder: null })
      .where(and(eq(requests.serverId, id), inArray(requests.status, ['pending', 'approved', 'failed'])))
      .run();
    const gone = tx.delete(arrServers).where(eq(arrServers.id, id)).returning({ id: arrServers.id }).get();
    if (!gone) throw new HttpError(404, NOT_FOUND);
    ensureDefaults(tx);
  });
  forgetArrOptions(db, id);
}

/**
 * Démarrage : reprise des anciens réglages `radarr`/`sonarr`, que la migration 0010 a copiés une première fois. Un
 * réglage modifié après cette copie (déploiement entre les deux versions) met à jour le serveur par défaut non 4K du
 * type (ou le crée), puis le réglage est supprimé : il n'est plus lu nulle part. La clé, déjà chiffrée, est copiée telle
 * quelle. Un réglage incomplet (impossible par l'appli) est laissé en place.
 */
export function adoptLegacyArrSettings(db: Db) {
  const legacy = db
    .select()
    .from(settings)
    .where(inArray(settings.key, [...arrKinds]))
    .all();
  if (legacy.length === 0) return;
  db.transaction((tx) => {
    for (const { key, value, updatedAt } of legacy) {
      const kind = key as ArrKind;
      let old: Record<string, unknown>;
      try {
        old = JSON.parse(value) as Record<string, unknown>;
      } catch {
        continue;
      }
      const { url, apiKey, qualityProfileId, rootFolderPath } = old;
      if (
        typeof url !== 'string' ||
        typeof apiKey !== 'string' ||
        typeof qualityProfileId !== 'number' ||
        typeof rootFolderPath !== 'string'
      )
        continue;
      const columns = {
        url,
        apiKey,
        qualityProfileId,
        rootFolderPath,
        ...typeColumnsOf(kind, old as Parameters<typeof typeColumnsOf>[1]),
      };
      const current = tx
        .select()
        .from(arrServers)
        .where(and(eq(arrServers.type, kind), eq(arrServers.is4k, false), eq(arrServers.isDefault, true)))
        .get();
      if (!current)
        tx.insert(arrServers)
          .values({ type: kind, name: arrKindLabels[kind], isDefault: true, ...columns })
          .run();
      else if (updatedAt > current.updatedAt)
        tx.update(arrServers)
          .set({ ...columns, updatedAt })
          .where(eq(arrServers.id, current.id))
          .run();
      tx.delete(settings).where(eq(settings.key, key)).run();
    }
  });
}
