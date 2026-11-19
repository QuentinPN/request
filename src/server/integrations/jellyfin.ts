import { z } from 'zod';
import { mediaServerKindLabels, type ServiceConnection, type Setting } from '../../shared/settings.ts';
import {
  authenticateWith,
  type EmbyFamilyClient,
  latestItemsWith,
  librariesOf,
  librarySchema,
  mapBounded,
  parentsOf,
  providerItemSchema,
  queryAll,
  seasonAvailabilityWith,
  serverIdWith,
  systemInfoWith,
  toEmbyItem,
  toEmbyListedUser,
  userSchema,
  verifyUserTokenWith,
} from './emby.ts';
import { createClient } from './http.ts';
import { type MediaServer, type MediaServerItem, refuseCredentials, toServerItem } from './media-server.ts';

/**
 * Jellyfin (10.10, 10.11) : l'API d'Emby dont il est issu, à trois différences près (docs/integrations.md) : l'en-tête
 * `Authorization: MediaBrowser …` (Jellyfin n'accepte `X-Emby-*` qu'en mode « legacy »), les listes `/Users` et
 * `/Library/VirtualFolders` sans `/Query`, et pas d'`AnyProviderIdEquals` : la disponibilité vient d'un balayage des
 * bibliothèques (`ProviderIds`), mis en cache par l'appelant.
 */
const SERVICE = mediaServerKindLabels.jellyfin;
const AUTHORIZATION = 'MediaBrowser Client="Request", Device="Server", DeviceId="request", Version="1.0"';

const authorization = (apiKey: string) => `${AUTHORIZATION}, Token="${apiKey}"`;

const jellyfinClient = (config: ServiceConnection): EmbyFamilyClient =>
  createClient({ service: SERVICE, baseUrl: config.url, headers: { Authorization: authorization(config.apiKey) } });

/** Élément balayé : les éléments « Virtual » (connus de Jellyfin, sans fichier) ne comptent pas. */
const scannedItemSchema = providerItemSchema.extend({ LocationType: z.string().nullish() });

/** Tous les films (ou séries) des bibliothèques suivies, page après page, avec leurs ids TMDB/TVDB. */
async function scanJellyfinItems(
  client: EmbyFamilyClient,
  { type, libraryIds }: { type: 'movie' | 'series'; libraryIds?: readonly string[] },
): Promise<MediaServerItem[]> {
  const pages = await mapBounded(parentsOf(libraryIds), (parentId) =>
    queryAll(client, '/Items', scannedItemSchema, {
      Recursive: true,
      IncludeItemTypes: type === 'movie' ? 'Movie' : 'Series',
      Fields: 'ProviderIds',
      ParentId: parentId,
    }),
  );
  const found = new Map<string, MediaServerItem>();
  for (const item of pages.flat()) {
    if (item.LocationType === 'Virtual') continue;
    const serverItem = toServerItem(toEmbyItem(item));
    found.set(serverItem.itemId, serverItem);
  }
  return [...found.values()];
}

export function jellyfinServer(config: Setting<'mediaServer'>): MediaServer {
  const client = jellyfinClient(config);
  return {
    kind: 'jellyfin',
    config,
    test: () => systemInfoWith(client),
    serverId: () => serverIdWith(client),
    authenticate: (credentials) =>
      credentials.method === 'password'
        ? authenticateWith(
            { service: SERVICE, baseUrl: config.url, headers: { Authorization: AUTHORIZATION } },
            credentials.username,
            credentials.password,
          )
        : refuseCredentials('jellyfin'),
    // Le jeton seul, sans les champs d'appareil d'Request : Jellyfin ne doit rien rattacher à l'appareil du membre.
    verifyUserToken: (token, userId) =>
      verifyUserTokenWith(
        { service: SERVICE, baseUrl: config.url, headers: { Authorization: `MediaBrowser Token="${token}"` } },
        userId,
      ),
    listUsers: async () => (await client.get('/Users', z.array(userSchema))).map(toEmbyListedUser),
    listLibraries: async () => librariesOf(await client.get('/Library/VirtualFolders', z.array(librarySchema))),
    lookup: { mode: 'scan', list: (query) => scanJellyfinItems(client, query) },
    seasonAvailability: (itemId) => seasonAvailabilityWith(client, itemId),
    latestItems: (options) => latestItemsWith(client, options),
    avatarRequest: (path) => ({
      url: `${config.url}${path}`,
      headers: { Authorization: authorization(config.apiKey) },
    }),
  };
}
