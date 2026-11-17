import { z } from 'zod';
import type { Connection } from '../../shared/settings.ts';
import type { EmbyLibrary } from '../../shared/setup.ts';
import { createClient, httpRequest, IntegrationError } from './http.ts';

/** Adresse et clé suffisent : les autres réglages d'Emby (bibliothèques suivies) ne servent pas aux appels. */
export type EmbyConfig = Connection<'emby'>;

const SERVICE = 'Emby';
/** Nombre maximal d'identifiants par requête `AnyProviderIdEquals` (liste séparée par des virgules). */
const PROVIDER_ID_CHUNK = 50;
const AUTHORIZATION = 'MediaBrowser Client="Request", Device="Server", DeviceId="request", Version="1.0"';

const embyClient = (config: EmbyConfig) =>
  createClient({ service: SERVICE, baseUrl: config.url, headers: { 'X-Emby-Token': config.apiKey } });

// --- Schémas (tolérants : champs en trop ignorés, champs facultatifs absents acceptés) ---

/** Les ids Emby sont des chaînes, parfois des nombres selon la version. */
const id = z.union([z.string(), z.number()]).transform(String);

const systemInfoSchema = z.object({ ServerName: z.string(), Version: z.string(), Id: id });

const userSchema = z.object({
  Id: id,
  Name: z.string(),
  PrimaryImageTag: z.string().nullish(),
  Policy: z.object({ IsAdministrator: z.boolean().nullish(), IsDisabled: z.boolean().nullish() }).nullish(),
});
type EmbyUserDto = z.infer<typeof userSchema>;

// `AccessToken` volontairement absent du schéma : Zod l'écarte, il ne sort jamais de ce module.
const authenticationSchema = z.object({ User: userSchema });

const librariesSchema = z.array(
  z.object({ ItemId: id.nullish(), Name: z.string(), CollectionType: z.string().nullish() }),
);

const itemsSchema = z.object({
  Items: z.array(
    z.object({
      Id: id,
      Name: z.string(),
      ProviderIds: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullish(),
    }),
  ),
});

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

export type { EmbyLibrary };

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

const toEmbyUser = (user: EmbyUserDto): EmbyUser => ({
  id: user.Id,
  name: user.Name,
  isAdmin: user.Policy?.IsAdministrator ?? false,
  avatarUrl: user.PrimaryImageTag
    ? `/Users/${user.Id}/Images/Primary?tag=${encodeURIComponent(user.PrimaryImageTag)}`
    : null,
});

/** Valide l'adresse et la clé d'API (assistant de configuration). */
export async function testEmby(config: EmbyConfig): Promise<EmbyServerInfo> {
  const info = await embyClient(config).get('/System/Info', systemInfoSchema);
  return { serverName: info.ServerName, version: info.Version, serverId: info.Id };
}

/**
 * Connexion d'un membre avec ses identifiants Emby. Le mot de passe n'est ni conservé ni journalisé ;
 * le jeton d'accès renvoyé par Emby est écarté (Request ouvre sa propre session).
 */
export async function authenticateEmbyUser(config: EmbyConfig, username: string, password: string): Promise<EmbyUser> {
  const { User } = await httpRequest({
    service: SERVICE,
    baseUrl: config.url,
    path: '/Users/AuthenticateByName',
    method: 'POST',
    headers: { 'X-Emby-Authorization': AUTHORIZATION },
    body: { Username: username, Pw: password },
    schema: authenticationSchema,
    messages: { unauthorized: 'Identifiant ou mot de passe Emby incorrect' },
  }).catch((error: unknown) => {
    // 403 : le compte existe mais Emby refuse l'accès (désactivé, hors horaires…), pas un mauvais mot de passe.
    if (error instanceof IntegrationError && error.status === 403) {
      throw new IntegrationError(error.kind, error.service, 'Compte Emby désactivé ou non autorisé', {
        status: error.status,
        ...(error.url !== undefined && { url: error.url }),
      });
    }
    throw error;
  });
  return toEmbyUser(User);
}

export async function listEmbyUsers(config: EmbyConfig): Promise<EmbyListedUser[]> {
  const users = await embyClient(config).get('/Users', z.array(userSchema));
  return users.map((user) => ({ ...toEmbyUser(user), isDisabled: user.Policy?.IsDisabled ?? false }));
}

export async function listEmbyLibraries(config: EmbyConfig): Promise<EmbyLibrary[]> {
  const folders = await embyClient(config).get('/Library/VirtualFolders', librariesSchema);
  return folders.flatMap((folder): EmbyLibrary[] => {
    if (!folder.ItemId) return [];
    const type =
      folder.CollectionType === 'movies' || folder.CollectionType === 'tvshows' ? folder.CollectionType : 'other';
    return [{ id: folder.ItemId, name: folder.Name, type }];
  });
}

const chunk = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

/** Lit un identifiant de fournisseur sans tenir compte de la casse de la clé (`Tmdb`, `tmdb`…). */
function providerId(providerIds: Record<string, string | number | null> | null | undefined, provider: 'tmdb' | 'tvdb') {
  const raw = Object.entries(providerIds ?? {}).find(([key]) => key.toLowerCase() === provider)?.[1];
  const value = Number(raw);
  return raw != null && Number.isInteger(value) ? value : undefined;
}

/**
 * Éléments d'Emby correspondant à des ids TMDB et/ou TVDB. Les ids sont envoyés par lots, un fournisseur par
 * requête (`AnyProviderIdEquals=tmdb.603,tmdb.604`) ; chaque résultat est rapproché par ses `ProviderIds`.
 */
export async function findEmbyItems(
  config: EmbyConfig,
  query: { type: 'movie' | 'series'; tmdbIds?: readonly number[]; tvdbIds?: readonly number[] },
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

  for (const batch of batches) {
    const { Items } = await client.get('/Items', itemsSchema, {
      query: {
        Recursive: true,
        IncludeItemTypes: query.type === 'movie' ? 'Movie' : 'Series',
        Fields: 'ProviderIds',
        AnyProviderIdEquals: batch.join(','),
      },
    });
    for (const item of Items) {
      const tmdbId = providerId(item.ProviderIds, 'tmdb');
      const tvdbId = providerId(item.ProviderIds, 'tvdb');
      const requested = (tmdbId !== undefined && tmdbIds.has(tmdbId)) || (tvdbId !== undefined && tvdbIds.has(tvdbId));
      if (!requested) continue;
      found.set(item.Id, {
        embyId: item.Id,
        name: item.Name,
        ...(tmdbId !== undefined && { tmdbId }),
        ...(tvdbId !== undefined && { tvdbId }),
      });
    }
  }
  return [...found.values()];
}

/** Épisodes présents par saison d'une série Emby (triées par numéro de saison). */
export async function getEmbySeasonAvailability(
  config: EmbyConfig,
  seriesEmbyId: string,
): Promise<EmbySeasonAvailability[]> {
  const { Items } = await embyClient(config).get('/Items', episodesSchema, {
    query: {
      ParentId: seriesEmbyId,
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
  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, episodesPresent]) => ({ seasonNumber, episodesPresent, isSpecials: seasonNumber === 0 }));
}

/** Lien « Regarder dans Emby » (interface web ; format non documenté officiellement, `serverId` requis). */
export function embyWebLink(baseUrl: string, serverId: string, itemId: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/web/index.html#!/item?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(serverId)}`;
}
