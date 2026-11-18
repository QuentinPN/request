import { z } from 'zod';
import { keyOf } from '../../shared/media.ts';
import { mediaServerKindLabels, type ServiceConnection } from '../../shared/settings.ts';
import type { MediaLibrary } from '../../shared/setup.ts';
import { createClient, httpRequest, IntegrationError } from './http.ts';

/** Adresse et clé suffisent : les autres réglages d'Emby (bibliothèques suivies) ne servent pas aux appels. */
export type EmbyConfig = ServiceConnection;

const SERVICE = mediaServerKindLabels.emby;
/** Nombre maximal d'identifiants par requête `AnyProviderIdEquals` (liste séparée par des virgules). */
const PROVIDER_ID_CHUNK = 50;
/** Forme documentée par l'API REST d'Emby 4.10 (`Emby Client=…, Device=…, DeviceId=…, Version=…`). */
const AUTHORIZATION = 'Emby Client="Request", Device="Server", DeviceId="request", Version="1.0"';

/**
 * Client d'un serveur de la famille Emby (Emby, Jellyfin) : seuls le nom et l'en-tête d'authentification diffèrent,
 * les appels communs (`latestItemsWith`, `seasonAvailabilityWith`…) le reçoivent tout fait.
 */
export type EmbyFamilyClient = ReturnType<typeof createClient>;

/** En-tête d'authentification d'Emby : la clé d'API. */
const embyHeaders = (config: EmbyConfig) => ({ 'X-Emby-Token': config.apiKey });

const embyClient = (config: EmbyConfig): EmbyFamilyClient =>
  createClient({ service: SERVICE, baseUrl: config.url, headers: embyHeaders(config) });

// --- Schémas (tolérants : champs en trop ignorés, champs facultatifs absents acceptés) ---

/** Les ids Emby sont des chaînes, parfois des nombres selon la version. */
const id = z.union([z.string(), z.number()]).transform(String);

export const systemInfoSchema = z.object({ ServerName: z.string(), Version: z.string(), Id: id });
export const publicInfoSchema = z.object({ Id: id });

export const userSchema = z.object({
  Id: id,
  Name: z.string(),
  PrimaryImageTag: z.string().nullish(),
  Policy: z.object({ IsAdministrator: z.boolean().nullish(), IsDisabled: z.boolean().nullish() }).nullish(),
});
type EmbyUserDto = z.infer<typeof userSchema>;

// `AccessToken` volontairement absent du schéma : Zod l'écarte, il ne sort jamais de ce module.
const authenticationSchema = z.object({ User: userSchema });

/**
 * Réponse des listes documentées d'Emby 4.10 (`/Users/Query`, `/Library/VirtualFolders/Query`) : `{ Items,
 * TotalRecordCount }`. `GET /Users` et `GET /Library/VirtualFolders` n'apparaissent plus dans sa référence.
 */
const queryResult = <T extends z.ZodType>(item: T) =>
  z.object({ Items: z.array(item), TotalRecordCount: z.number().int().nonnegative().nullish() });

export const librarySchema = z.object({ ItemId: id.nullish(), Name: z.string(), CollectionType: z.string().nullish() });

/** Taille de page des listes `…/Query` : Emby peut plafonner une réponse, on lit page après page. */
const QUERY_PAGE_SIZE = 200;

/**
 * Lit toutes les pages d'une liste paginée (`StartIndex`/`Limit`) jusqu'à `TotalRecordCount`. `query` : paramètres
 * fixes de chaque page (balayage des éléments de Jellyfin).
 */
export async function queryAll<T extends z.ZodType>(
  client: EmbyFamilyClient,
  path: string,
  item: T,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<z.output<T>[]> {
  const schema = queryResult(item);
  const all: z.output<T>[] = [];
  for (;;) {
    const { Items, TotalRecordCount } = await client.get(path, schema, {
      query: { ...query, StartIndex: all.length, Limit: QUERY_PAGE_SIZE },
    });
    all.push(...Items);
    const total = TotalRecordCount ?? all.length;
    if (Items.length === 0 || all.length >= total) return all;
  }
}

export const providerIdsSchema = z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullish();

const itemsSchema = z.object({
  Items: z.array(z.object({ Id: id, Name: z.string(), ProviderIds: providerIdsSchema })),
});
/** Un élément et ses ids de fournisseurs, tel que les listes `/Items` le donnent. */
export const providerItemSchema = itemsSchema.shape.Items.element;

const episodesSchema = z.object({
  Items: z.array(z.object({ ParentIndexNumber: z.number().nullish(), LocationType: z.string().nullish() })),
});

// --- Types publics ---

export interface EmbyServerInfo {
  serverName: string;
  version: string;
  serverId: string;
}

export interface EmbyUser {
  id: string;
  name: string;
  isAdmin: boolean;
  /**
   * Chemin relatif à l'adresse d'Emby (`/Users/{id}/Images/Primary?tag=…`), `null` sans photo.
   * Volontairement sans hôte ni clé d'API : le serveur d'Request le relaiera au navigateur.
   */
  avatarUrl: string | null;
}

export interface EmbyListedUser extends EmbyUser {
  isDisabled: boolean;
}

export type EmbyLibrary = MediaLibrary;

export interface EmbyItem {
  embyId: string;
  tmdbId?: number;
  tvdbId?: number;
  name: string;
}

export interface EmbySeasonAvailability {
  seasonNumber: number;
  /** Épisodes réellement présents (les épisodes « Virtual », connus mais sans fichier, ne comptent pas). */
  episodesPresent: number;
  /** Saison 0 : les « Specials », à traiter à part de la disponibilité des vraies saisons. */
  isSpecials: boolean;
}

// --- Fonctions ---

export const toEmbyUser = (user: EmbyUserDto): EmbyUser => ({
  id: user.Id,
  name: user.Name,
  isAdmin: user.Policy?.IsAdministrator ?? false,
  avatarUrl: user.PrimaryImageTag
    ? `/Users/${user.Id}/Images/Primary?tag=${encodeURIComponent(user.PrimaryImageTag)}`
    : null,
});

export const toEmbyListedUser = (user: EmbyUserDto): EmbyListedUser => ({
  ...toEmbyUser(user),
  isDisabled: user.Policy?.IsDisabled ?? false,
});

/** `/System/Info` (clé d'API requise) : nom, version et id du serveur. */
export async function systemInfoWith(client: EmbyFamilyClient): Promise<EmbyServerInfo> {
  const info = await client.get('/System/Info', systemInfoSchema);
  return { serverName: info.ServerName, version: info.Version, serverId: info.Id };
}

/** Valide l'adresse et la clé d'API (assistant de configuration). */
export const testEmby = (config: EmbyConfig): Promise<EmbyServerInfo> => systemInfoWith(embyClient(config));

/** Id du serveur (`/System/Info/Public`, sans clé d'API) : le lien « Regarder dans… » le réclame. */
export async function serverIdWith(client: EmbyFamilyClient): Promise<string> {
  return (await client.get('/System/Info/Public', publicInfoSchema)).Id;
}

export const getEmbyServerId = (config: EmbyConfig): Promise<string> => serverIdWith(embyClient(config));

/**
 * `POST /Users/AuthenticateByName`, commun à Emby et Jellyfin (seuls le nom du service et l'en-tête diffèrent).
 * Le mot de passe n'est ni conservé ni journalisé ; le jeton d'accès renvoyé est écarté (Request ouvre sa propre
 * session).
 */
export async function authenticateWith(
  { service, baseUrl, headers }: { service: string; baseUrl: string; headers: Record<string, string> },
  username: string,
  password: string,
): Promise<EmbyUser> {
  const { User } = await httpRequest({
    service,
    baseUrl,
    path: '/Users/AuthenticateByName',
    method: 'POST',
    headers,
    body: { Username: username, Pw: password },
    schema: authenticationSchema,
    messages: { unauthorized: `Identifiant ou mot de passe ${service} incorrect` },
  }).catch((error: unknown) => {
    // 403 : le compte existe mais le serveur refuse l'accès (désactivé, hors horaires…), pas un mauvais mot de passe.
    if (error instanceof IntegrationError && error.status === 403) {
      throw new IntegrationError(error.kind, error.service, `Compte ${service} désactivé ou non autorisé`, {
        status: error.status,
        ...(error.url !== undefined && { url: error.url }),
      });
    }
    throw error;
  });
  return toEmbyUser(User);
}

/** Connexion d'un membre avec ses identifiants Emby. */
export const authenticateEmbyUser = (config: EmbyConfig, username: string, password: string): Promise<EmbyUser> =>
  authenticateWith(
    { service: SERVICE, baseUrl: config.url, headers: { 'X-Emby-Authorization': AUTHORIZATION } },
    username,
    password,
  );

export async function listEmbyUsers(config: EmbyConfig): Promise<EmbyListedUser[]> {
  // Sans filtre `IsDisabled` : les comptes désactivés sont listés aussi (champ `isDisabled`).
  const users = await queryAll(embyClient(config), '/Users/Query', userSchema);
  return users.map(toEmbyListedUser);
}

/** Bibliothèques classées films, séries ou autre ; celles sans `ItemId` sont écartées. */
export function librariesOf(folders: readonly z.infer<typeof librarySchema>[]): MediaLibrary[] {
  return folders.flatMap((folder): MediaLibrary[] => {
    if (!folder.ItemId) return [];
    const type =
      folder.CollectionType === 'movies' || folder.CollectionType === 'tvshows' ? folder.CollectionType : 'other';
    return [{ id: folder.ItemId, name: folder.Name, type }];
  });
}

export async function listEmbyLibraries(config: EmbyConfig): Promise<EmbyLibrary[]> {
  return librariesOf(await queryAll(embyClient(config), '/Library/VirtualFolders/Query', librarySchema));
}

/** Nombre d'appels Emby simultanés au plus : on ne noie pas un petit serveur, sans tout enchaîner un par un. */
const EMBY_CONCURRENCY = 3;

/** `fn` sur chaque élément, `EMBY_CONCURRENCY` à la fois ; résultats dans l'ordre. */
export async function mapBounded<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(EMBY_CONCURRENCY, items.length) }, worker));
  return results;
}

const chunk = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

/** Lit un identifiant de fournisseur sans tenir compte de la casse de la clé (`Tmdb`, `tmdb`…). */
export function providerId(providerIds: z.infer<typeof providerIdsSchema>, provider: 'tmdb' | 'tvdb') {
  const raw = Object.entries(providerIds ?? {}).find(([key]) => key.toLowerCase() === provider)?.[1];
  const value = Number(raw);
  return raw != null && Number.isInteger(value) ? value : undefined;
}

/** `ParentId` de chaque bibliothèque suivie ; aucune bibliothèque choisie = tout le serveur (une requête sans filtre). */
export const parentsOf = (libraryIds: readonly string[] = []): Array<string | undefined> =>
  libraryIds.length > 0 ? [...libraryIds] : [undefined];

/** Élément d'une liste `/Items` vers `EmbyItem` (ids TMDB/TVDB lus dans ses `ProviderIds`). */
export function toEmbyItem(item: z.infer<typeof providerItemSchema>): EmbyItem {
  const tmdbId = providerId(item.ProviderIds, 'tmdb');
  const tvdbId = providerId(item.ProviderIds, 'tvdb');
  return {
    embyId: item.Id,
    name: item.Name,
    ...(tmdbId !== undefined && { tmdbId }),
    ...(tvdbId !== undefined && { tvdbId }),
  };
}

/**
 * Éléments d'Emby correspondant à des ids TMDB et/ou TVDB. Les ids sont envoyés par lots, un fournisseur par
 * requête (`AnyProviderIdEquals=tmdb.603,tmdb.604`) ; chaque résultat est rapproché par ses `ProviderIds`.
 * `libraryIds` limite la recherche aux bibliothèques suivies (`ParentId`, une requête par bibliothèque et par lot).
 */
export async function findEmbyItems(
  config: EmbyConfig,
  query: {
    type: 'movie' | 'series';
    tmdbIds?: readonly number[];
    tvdbIds?: readonly number[];
    libraryIds?: readonly string[];
  },
): Promise<EmbyItem[]> {
  const tmdbIds = new Set(query.tmdbIds);
  const tvdbIds = new Set(query.tvdbIds);
  // Un type de fournisseur par requête : on ne s'appuie pas sur la sémantique d'un mélange (OU/ET) côté Emby.
  const batchesOf = (provider: string, ids: Set<number>) =>
    chunk(
      [...ids].map((n) => `${provider}.${n}`),
      PROVIDER_ID_CHUNK,
    );
  const batches = [...batchesOf('tmdb', tmdbIds), ...batchesOf('tvdb', tvdbIds)];
  const client = embyClient(config);
  const found = new Map<string, EmbyItem>();

  const requests = batches.flatMap((batch) => parentsOf(query.libraryIds).map((parentId) => ({ batch, parentId })));
  await mapBounded(requests, async ({ batch, parentId }) => {
    const { Items } = await client.get('/Items', itemsSchema, {
      query: {
        Recursive: true,
        IncludeItemTypes: query.type === 'movie' ? 'Movie' : 'Series',
        Fields: 'ProviderIds',
        AnyProviderIdEquals: batch.join(','),
        ParentId: parentId,
      },
    });
    for (const item of Items) {
      const match = toEmbyItem(item);
      const { tmdbId, tvdbId } = match;
      const requested = (tmdbId !== undefined && tmdbIds.has(tmdbId)) || (tvdbId !== undefined && tvdbIds.has(tvdbId));
      if (requested) found.set(item.Id, match);
    }
  });
  return [...found.values()];
}

export interface EmbyLatestItem {
  type: 'movie' | 'tv';
  tmdbId: number;
  /** Date d'ajout à la bibliothèque (ms depuis l'époque Unix), `0` si Emby ne la donne pas. */
  addedAt: number;
}

const latestSchema = z.object({
  Items: z.array(
    z.object({
      Type: z.string().nullish(),
      DateCreated: z.string().nullish(),
      ProviderIds: providerIdsSchema,
    }),
  ),
});

/** Du plus récent au plus ancien, un titre une seule fois (son ajout le plus récent), `limit` au plus. */
export function newestFirst<T extends { type: 'movie' | 'tv'; tmdbId: number; addedAt: number }>(
  items: readonly T[],
  limit: number,
): T[] {
  const sorted = [...items].sort((a, b) => b.addedAt - a.addedAt);
  // Un même titre peut figurer dans deux bibliothèques : on garde son ajout le plus récent.
  const unique = new Map<string, T>();
  for (const item of sorted) if (!unique.has(keyOf(item))) unique.set(keyOf(item), item);
  return [...unique.values()].slice(0, limit);
}

/** Derniers ajouts par bibliothèque (voir `latestEmbyItems`), avec un client de la famille Emby. */
export async function latestItemsWith(
  client: EmbyFamilyClient,
  { libraryIds, limit, userId }: { libraryIds?: readonly string[]; limit: number; userId?: string },
): Promise<EmbyLatestItem[]> {
  const pages = await mapBounded(parentsOf(libraryIds), async (parentId) => {
    try {
      return await client.get('/Items', latestSchema, {
        query: {
          Recursive: true,
          IncludeItemTypes: 'Movie,Series',
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          Fields: 'ProviderIds,DateCreated',
          Limit: limit,
          ParentId: parentId,
          UserId: userId,
        },
      });
    } catch (error) {
      // Comportement d'Emby non vérifié : pour une bibliothèque interdite au membre, il peut répondre 4xx plutôt
      // qu'une liste vide. Cette bibliothèque est alors ignorée, sans faire échouer toute la rangée.
      if (userId && error instanceof IntegrationError && [400, 403, 404].includes(error.status ?? 0))
        return { Items: [] };
      throw error;
    }
  });
  const items = pages.flatMap(({ Items }) =>
    Items.flatMap((item): EmbyLatestItem[] => {
      const type = item.Type === 'Movie' ? 'movie' : item.Type === 'Series' ? 'tv' : undefined;
      const tmdbId = providerId(item.ProviderIds, 'tmdb');
      if (!type || tmdbId === undefined) return [];
      return [{ type, tmdbId, addedAt: Date.parse(item.DateCreated ?? '') || 0 }];
    }),
  );
  return newestFirst(items, limit);
}

/**
 * Films et séries les plus récemment ajoutés aux bibliothèques suivies (une requête par bibliothèque), du plus récent
 * au plus ancien. Les éléments sans id TMDB sont écartés : TMDB fournit affiche et résumé. Avec `userId` (id Emby
 * du membre), Emby n'y garde que ce que ce membre peut voir : ses bibliothèques et son contrôle parental.
 */
export const latestEmbyItems = (
  config: EmbyConfig,
  options: { libraryIds?: readonly string[]; limit: number; userId?: string },
): Promise<EmbyLatestItem[]> => latestItemsWith(embyClient(config), options);

/** Épisodes présents par saison d'une série (voir `getEmbySeasonAvailability`), avec un client de la famille Emby. */
export async function seasonAvailabilityWith(
  client: EmbyFamilyClient,
  seriesId: string,
): Promise<EmbySeasonAvailability[]> {
  const { Items } = await client.get('/Items', episodesSchema, {
    query: {
      ParentId: seriesId,
      Recursive: true,
      IncludeItemTypes: 'Episode',
      Fields: 'LocationType,ParentIndexNumber',
    },
  });
  const counts = new Map<number, number>();
  for (const episode of Items) {
    if (episode.LocationType === 'Virtual' || episode.ParentIndexNumber == null) continue;
    counts.set(episode.ParentIndexNumber, (counts.get(episode.ParentIndexNumber) ?? 0) + 1);
  }
  return seasonsFromCounts(counts);
}

/** Épisodes comptés par numéro de saison → saisons triées (la 0, « Specials », marquée à part). */
export const seasonsFromCounts = (counts: ReadonlyMap<number, number>): EmbySeasonAvailability[] =>
  [...counts]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, episodesPresent]) => ({ seasonNumber, episodesPresent, isSpecials: seasonNumber === 0 }));

/** Épisodes présents par saison d'une série Emby (triées par numéro de saison). */
export const getEmbySeasonAvailability = (
  config: EmbyConfig,
  seriesEmbyId: string,
): Promise<EmbySeasonAvailability[]> => seasonAvailabilityWith(embyClient(config), seriesEmbyId);

/** Relais d'une photo de membre : adresse complète et en-tête de la clé (le navigateur ne voit ni l'une ni l'autre). */
export const embyAvatarRequest = (config: EmbyConfig, path: string) => ({
  url: `${config.url}${path}`,
  headers: embyHeaders(config),
});
