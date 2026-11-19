import { type MediaServerKind, mediaServerKindLabels, type Setting } from '../../shared/settings.ts';
import type { MediaLibrary } from '../../shared/setup.ts';
import {
  authenticateEmbyUser,
  type EmbyItem,
  type EmbyLatestItem,
  type EmbyListedUser,
  type EmbySeasonAvailability,
  type EmbyServerInfo,
  type EmbyUser,
  embyAvatarRequest,
  findEmbyItems,
  getEmbySeasonAvailability,
  getEmbyServerId,
  latestEmbyItems,
  listEmbyLibraries,
  listEmbyUsers,
  testEmby,
  verifyEmbyUserToken,
} from './emby.ts';
import { IntegrationError } from './http.ts';

// --- Contrat commun d'Emby, Jellyfin et Plex ---

/** Nom, version et id du serveur (`serverId` d'Emby/Jellyfin, `machineIdentifier` de Plex). */
export type MediaServerInfo = EmbyServerInfo;
/** Compte d'un membre ; `avatarUrl` : chemin (Emby, Jellyfin) ou adresse plex.tv, relayé par `avatarRequest`. */
export type MediaServerUser = EmbyUser;
export type MediaServerListedUser = EmbyListedUser;
export type MediaServerSeason = EmbySeasonAvailability;
export type MediaServerLatestItem = EmbyLatestItem;

/** Élément trouvé sur le serveur : `itemId` (id Emby/Jellyfin, `ratingKey` Plex) sert au lien « Regarder dans… ». */
export interface MediaServerItem {
  itemId: string;
  tmdbId?: number;
  tvdbId?: number;
  name: string;
}

export interface MediaItemQuery {
  type: 'movie' | 'series';
  tmdbIds?: readonly number[];
  tvdbIds?: readonly number[];
  /** Bibliothèques où chercher ; aucune = toutes. */
  libraryIds?: readonly string[];
}

/** Justificatif d'un membre : identifiant et mot de passe (Emby, Jellyfin), ou jeton plex.tv issu du code PIN (Plex). */
export type MemberCredentials =
  | { method: 'password'; username: string; password: string }
  | { method: 'plex'; token: string };

/**
 * Recherche de titres : ciblée par ids (Emby, `AnyProviderIdEquals`), ou balayage complet des bibliothèques (Jellyfin,
 * Plex : pas de filtre par id), que l'appelant garde en cache puis filtre avec `matchItems`.
 */
export type MediaItemLookup =
  | { mode: 'search'; find: (query: MediaItemQuery) => Promise<MediaServerItem[]> }
  | { mode: 'scan'; list: (query: Omit<MediaItemQuery, 'tmdbIds' | 'tvdbIds'>) => Promise<MediaServerItem[]> };

/**
 * Le serveur multimédia, quel qu'il soit : seul point d'entrée de la connexion des membres, de leur import, des
 * bibliothèques, de la disponibilité, des épisodes, des derniers ajouts et des photos. Une implémentation par type.
 */
export interface MediaServer {
  kind: MediaServerKind;
  config: Setting<'mediaServer'>;
  /** Valide l'adresse et la clé (ou le jeton Plex du propriétaire). */
  test: () => Promise<MediaServerInfo>;
  /** Id du serveur, pour le lien « Regarder dans… ». */
  serverId: () => Promise<string>;
  /** Membre authentifié ; `unauthorized` si refusé. Aucun mot de passe ni jeton n'est conservé. */
  authenticate: (credentials: MemberCredentials) => Promise<MediaServerUser>;
  /**
   * Compte `userId`, si ce jeton d'accès vaut pour lui (clients natifs ; Emby et Jellyfin, Plex refuse) :
   * `unauthorized` sinon, `not_found` si le serveur ne connaît pas l'appel ou le compte. Le jeton n'est ni conservé ni
   * journalisé.
   */
  verifyUserToken: (token: string, userId: string) => Promise<MediaServerUser>;
  /** Comptes importables ; le propriétaire du serveur y est marqué `isAdmin`. */
  listUsers: () => Promise<MediaServerListedUser[]>;
  listLibraries: () => Promise<MediaLibrary[]>;
  lookup: MediaItemLookup;
  /** Épisodes présents par saison d'une série (`itemId` du serveur). */
  seasonAvailability: (itemId: string) => Promise<MediaServerSeason[]>;
  /** Derniers ajouts, du plus récent au plus ancien ; `userId` : limités à ce que ce membre voit (si le serveur le sait). */
  latestItems: (options: {
    libraryIds?: readonly string[];
    limit: number;
    userId?: string;
  }) => Promise<MediaServerLatestItem[]>;
  /** Adresse et en-têtes pour relayer la photo d'un membre, `null` si elle n'est pas relayable. */
  avatarRequest: (avatar: string) => { url: string; headers: Record<string, string> } | null;
}

/** Nom affiché d'un serveur (« Jellyfin ») : la définition partagée. */
export const labelOf = (server: Pick<MediaServer, 'kind'>) => mediaServerKindLabels[server.kind];

/** Mauvaise méthode de connexion pour ce serveur (mot de passe envoyé à Plex, jeton Plex à Emby). */
export const refuseCredentials = (kind: MediaServerKind): Promise<never> => {
  const service = mediaServerKindLabels[kind];
  return Promise.reject(
    new IntegrationError('unauthorized', service, `Ce mode de connexion ne s’applique pas à ${service}`),
  );
};

/** Élément de la famille Emby (Emby, Jellyfin) → élément du contrat commun (`embyId` devient `itemId`). */
export const toServerItem = ({ embyId, ...rest }: EmbyItem): MediaServerItem => ({ itemId: embyId, ...rest });

/** Éléments balayés correspondant aux ids TMDB/TVDB demandés. */
export function matchItems(items: readonly MediaServerItem[], query: MediaItemQuery): MediaServerItem[] {
  const tmdbIds = new Set(query.tmdbIds);
  const tvdbIds = new Set(query.tvdbIds);
  return items.filter(
    ({ tmdbId, tvdbId }) =>
      (tmdbId !== undefined && tmdbIds.has(tmdbId)) || (tvdbId !== undefined && tvdbIds.has(tvdbId)),
  );
}

// --- Emby : les fonctions de `emby.ts`, inchangées ---

export function embyServer(config: Setting<'mediaServer'>): MediaServer {
  return {
    kind: 'emby',
    config,
    test: () => testEmby(config),
    serverId: () => getEmbyServerId(config),
    authenticate: (credentials) =>
      credentials.method === 'password'
        ? authenticateEmbyUser(config, credentials.username, credentials.password)
        : refuseCredentials('emby'),
    verifyUserToken: (token, userId) => verifyEmbyUserToken(config, token, userId),
    listUsers: () => listEmbyUsers(config),
    listLibraries: () => listEmbyLibraries(config),
    lookup: {
      mode: 'search',
      find: async (query) => (await findEmbyItems(config, query)).map(toServerItem),
    },
    seasonAvailability: (itemId) => getEmbySeasonAvailability(config, itemId),
    latestItems: (options) => latestEmbyItems(config, options),
    avatarRequest: (path) => embyAvatarRequest(config, path),
  };
}
