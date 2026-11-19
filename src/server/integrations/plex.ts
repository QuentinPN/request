import { z } from 'zod';
import { mediaServerKindLabels, type Setting } from '../../shared/settings.ts';
import type { MediaLibrary } from '../../shared/setup.ts';
import { mapBounded, newestFirst, seasonsFromCounts } from './emby.ts';
import { createClient, IntegrationError } from './http.ts';
import {
  type MediaServer,
  type MediaServerLatestItem,
  type MediaServerListedUser,
  type MediaServerUser,
  refuseCredentials,
} from './media-server.ts';

/**
 * Plex : le serveur (Plex Media Server, jeton `X-Plex-Token` du propriétaire, réponses JSON) et plex.tv (code PIN de
 * connexion, comptes, amis ayant accès au serveur ; XML pour les deux listes du compte). Sources et points non
 * vérifiés sur une instance réelle : docs/integrations.md.
 */
const SERVICE = mediaServerKindLabels.plex;
const PLEX_TV_SERVICE = 'plex.tv';
export const PLEX_TV_URL = 'https://plex.tv';
/** Nom de l'application montré par Plex dans la fenêtre de connexion et la liste des appareils autorisés. */
export const PLEX_PRODUCT = 'Request';

/** plex.tv (remplaçable dans les tests) et identifiant d'appareil stable de cette installation. */
export interface PlexOptions {
  plexTvUrl?: string;
  clientId: string;
}

const plexHeaders = (clientId: string, token?: string): Record<string, string> => ({
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Client-Identifier': clientId,
  ...(token !== undefined && { 'X-Plex-Token': token }),
});

const serverClient = (config: Setting<'mediaServer'>, { clientId }: PlexOptions) =>
  createClient({ service: SERVICE, baseUrl: config.url, headers: plexHeaders(clientId, config.apiKey) });

const plexTvClient = ({ plexTvUrl = PLEX_TV_URL, clientId }: PlexOptions, token?: string) =>
  createClient({ service: PLEX_TV_SERVICE, baseUrl: plexTvUrl, headers: plexHeaders(clientId, token) });

// --- XML de plex.tv (`/api/users`, `/api/resources` : pas de JSON) ---

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });

interface XmlElement {
  attrs: Record<string, string>;
  /** Contenu entre les balises ouvrante et fermante, vide pour une balise auto-fermante. */
  inner: string;
}

/**
 * Éléments `<tag …>` d'un document XML plat (aucun `tag` imbriqué dans un autre), avec leurs attributs décodés.
 * Lecture minimale, suffisante pour les listes de plex.tv : pas de dépendance pour deux réponses.
 */
export function xmlElements(xml: string, tag: string): XmlElement[] {
  const element = new RegExp(`<${tag}\\b((?:[^>"]|"[^"]*")*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  return [...xml.matchAll(element)].map((match) => ({
    attrs: Object.fromEntries(
      [...(match[1] ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, name, value]) => [
        name,
        decodeEntities(value ?? ''),
      ]),
    ),
    inner: match[2] ?? '',
  }));
}

/** GET d'une liste XML de plex.tv ; une réponse qui n'en est pas une est une `bad_response`. */
async function plexTvXml(options: PlexOptions, token: string, path: string): Promise<string> {
  const xml = await plexTvClient(options, token).get(path, z.string(), {
    headers: { accept: 'application/xml' },
    responseType: 'text',
    query: path === '/api/resources' ? { includeHttps: 1 } : {},
  });
  if (!xml.includes('<MediaContainer'))
    throw new IntegrationError('bad_response', PLEX_TV_SERVICE, 'Réponse inattendue de plex.tv');
  return xml;
}

// --- Comptes (plex.tv) ---

const accountSchema = z.object({
  user: z.object({
    id: z.union([z.number(), z.string()]).transform(String),
    username: z.string().nullish(),
    title: z.string().nullish(),
    thumb: z.string().nullish(),
  }),
});

type PlexAccount = { id: string; name: string; thumb: string | null };

const toAccount = ({
  id,
  username,
  title,
  thumb,
}: {
  id: string;
  username?: string | null;
  title?: string | null;
  thumb?: string | null;
}): PlexAccount => ({
  id,
  name: title || username || `Plex ${id}`,
  thumb: thumb || null,
});

/** Compte plex.tv d'un jeton (`/users/account.json`, forme lue par Seerr). */
async function accountOf(options: PlexOptions, token: string, unauthorized: string): Promise<PlexAccount> {
  const { user } = await plexTvClient(options, token).get('/users/account.json', accountSchema, {
    messages: { unauthorized },
  });
  return toAccount(user);
}

/** Amis du propriétaire qui ont accès à ce serveur (`/api/users` : `<User>` et ses `<Server machineIdentifier>`). */
async function friendsWithAccess(options: PlexOptions, adminToken: string, machineId: string): Promise<PlexAccount[]> {
  const xml = await plexTvXml(options, adminToken, '/api/users');
  return xmlElements(xml, 'User').flatMap(({ attrs, inner }) => {
    const hasAccess = xmlElements(inner, 'Server').some((server) => server.attrs.machineIdentifier === machineId);
    return attrs.id && hasAccess ? [toAccount({ ...attrs, id: attrs.id })] : [];
  });
}

const toUser = (account: PlexAccount, isAdmin: boolean): MediaServerUser => ({
  id: account.id,
  name: account.name,
  isAdmin,
  avatarUrl: account.thumb,
});

// --- Serveur Plex (jeton du propriétaire, JSON) ---

const identitySchema = z.object({
  MediaContainer: z.object({
    friendlyName: z.string().nullish(),
    version: z.string(),
    machineIdentifier: z.string().min(1),
  }),
});

const sectionsSchema = z.object({
  MediaContainer: z.object({
    Directory: z
      .array(
        z.object({
          key: z.union([z.string(), z.number()]).transform(String),
          title: z.string(),
          type: z.string(),
          agent: z.string().nullish(),
        }),
      )
      .nullish(),
  }),
});

const guidSchema = z.array(z.object({ id: z.string() })).nullish();
const metadataSchema = z.object({
  ratingKey: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullish(),
  type: z.string().nullish(),
  /** Ancien agent : `com.plexapp.agents.themoviedb://603?lang=fr`. */
  guid: z.string().nullish(),
  /** Nouvel agent (`includeGuids=1`) : `[{ id: 'tmdb://603' }, { id: 'imdb://tt…' }]`. */
  Guid: guidSchema,
  addedAt: z.number().nullish(),
  index: z.number().nullish(),
  leafCount: z.number().nullish(),
});
type PlexMetadata = z.infer<typeof metadataSchema>;

const containerSchema = z.object({
  MediaContainer: z.object({ totalSize: z.number().nullish(), Metadata: z.array(metadataSchema).nullish() }),
});

const GUID = /^(?:com\.plexapp\.agents\.)?(tmdb|themoviedb|tvdb|thetvdb):\/\/(\d+)/;

/** Ids TMDB et TVDB d'un élément, par ses GUID (nouvel agent) ou son `guid` (anciens agents). */
export function plexIds(item: Pick<PlexMetadata, 'guid' | 'Guid'>): { tmdbId?: number; tvdbId?: number } {
  const ids: { tmdbId?: number; tvdbId?: number } = {};
  for (const raw of [...(item.Guid ?? []).map((g) => g.id), item.guid ?? '']) {
    const [, provider, value] = GUID.exec(raw) ?? [];
    if (!provider || !value) continue;
    const key = provider.endsWith('tvdb') ? 'tvdbId' : 'tmdbId';
    ids[key] ??= Number(value);
  }
  return ids;
}

/** Taille de page des listes d'une section (`X-Plex-Container-Start/Size`). */
const PAGE_SIZE = 200;

const libraryType = (type: string): MediaLibrary['type'] =>
  type === 'movie' ? 'movies' : type === 'show' ? 'tvshows' : 'other';

export function plexServer(config: Setting<'mediaServer'>, options: PlexOptions): MediaServer {
  const client = serverClient(config, options);
  const identity = async () => (await client.get('/', identitySchema)).MediaContainer;
  const serverId = async () => (await identity()).machineIdentifier;
  /** Compte plex.tv du propriétaire (celui du jeton enregistré). */
  const ownerAccount = () => accountOf(options, config.apiKey, 'Jeton Plex du propriétaire refusé par plex.tv');

  const listLibraries = async (): Promise<MediaLibrary[]> => {
    const { Directory } = (await client.get('/library/sections', sectionsSchema)).MediaContainer;
    // Comme Seerr : une section sans agent (`com.plexapp.agents.none`) n'a pas d'ids TMDB/TVDB à lire.
    return (Directory ?? [])
      .filter((d) => d.agent !== 'com.plexapp.agents.none')
      .map((d) => ({ id: d.key, name: d.title, type: libraryType(d.type) }));
  };

  /** Sections où chercher : celles choisies, sinon toutes celles du type. */
  const sectionsFor = async (type: MediaLibrary['type'] | null, libraryIds: readonly string[] = []) =>
    libraryIds.length > 0
      ? [...libraryIds]
      : (await listLibraries()).filter((l) => (type ? l.type === type : l.type !== 'other')).map((l) => l.id);

  /** Une page d'éléments d'une section. */
  const page = (sectionId: string, start: number, size: number, query: Record<string, string | number> = {}) =>
    client.get(`/library/sections/${encodeURIComponent(sectionId)}/all`, containerSchema, {
      query: { includeGuids: 1, ...query },
      headers: { 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(size) },
    });

  /** Tous les éléments d'une section, page après page. */
  async function allOf(sectionId: string): Promise<PlexMetadata[]> {
    const all: PlexMetadata[] = [];
    for (;;) {
      const { MediaContainer } = await page(sectionId, all.length, PAGE_SIZE);
      const items = MediaContainer.Metadata ?? [];
      all.push(...items);
      if (items.length < PAGE_SIZE || all.length >= (MediaContainer.totalSize ?? Number.POSITIVE_INFINITY)) return all;
    }
  }

  return {
    kind: 'plex',
    config,
    test: async () => {
      const info = await identity();
      // Le jeton doit être celui du propriétaire : c'est lui qui désigne le premier propriétaire de l'appli et dont les
      // amis peuvent se connecter.
      const xml = await plexTvXml(options, config.apiKey, '/api/resources');
      const owned = xmlElements(xml, 'Device').some(
        ({ attrs }) => attrs.clientIdentifier === info.machineIdentifier && attrs.owned === '1',
      );
      if (!owned)
        throw new IntegrationError(
          'unauthorized',
          SERVICE,
          'Ce jeton n’est pas celui du propriétaire de ce serveur Plex',
        );
      return { serverName: info.friendlyName || 'Plex', version: info.version, serverId: info.machineIdentifier };
    },
    serverId,
    authenticate: async (credentials) => {
      if (credentials.method !== 'plex') return refuseCredentials('plex');
      const account = await accountOf(options, credentials.token, 'Connexion Plex refusée ou expirée, recommencez');
      const owner = await ownerAccount();
      if (account.id === owner.id) return toUser(account, true);
      const friends = await friendsWithAccess(options, config.apiKey, await serverId());
      if (friends.some((f) => f.id === account.id)) return toUser(account, false);
      throw new IntegrationError('unauthorized', SERVICE, 'Ce compte Plex n’a pas accès à ce serveur', { status: 403 });
    },
    verifyUserToken: () => refuseCredentials('plex'),
    listUsers: async (): Promise<MediaServerListedUser[]> => {
      const [owner, friends] = await Promise.all([
        ownerAccount(),
        serverId().then((machineId) => friendsWithAccess(options, config.apiKey, machineId)),
      ]);
      return [toUser(owner, true), ...friends.map((f) => toUser(f, false))].map((u) => ({ ...u, isDisabled: false }));
    },
    listLibraries,
    lookup: {
      mode: 'scan',
      list: async ({ type, libraryIds }) => {
        const sections = await sectionsFor(type === 'movie' ? 'movies' : 'tvshows', libraryIds);
        const pages = await mapBounded(sections, allOf);
        const wanted = type === 'movie' ? 'movie' : 'show';
        return pages
          .flat()
          .flatMap((item) =>
            item.type === wanted ? [{ itemId: item.ratingKey, name: item.title ?? '', ...plexIds(item) }] : [],
          );
      },
    },
    seasonAvailability: async (ratingKey) => {
      const { MediaContainer } = await client.get(
        `/library/metadata/${encodeURIComponent(ratingKey)}/children`,
        containerSchema,
      );
      // Plex ne liste que les épisodes présents : `leafCount` de chaque saison les compte.
      const counts = new Map<number, number>();
      for (const season of MediaContainer.Metadata ?? [])
        if (season.index != null && (season.leafCount ?? 0) > 0) counts.set(season.index, season.leafCount ?? 0);
      return seasonsFromCounts(counts);
    },
    // Sans le jeton du membre (jamais conservé), Plex ne dit pas ce qu'il voit : la rangée vaut pour tous (DECISIONS.md).
    latestItems: async ({ libraryIds, limit }) => {
      const sections = await sectionsFor(null, libraryIds);
      const pages = await mapBounded(sections, (id) => page(id, 0, limit, { sort: 'addedAt:desc' }));
      const items = pages.flatMap(({ MediaContainer }) =>
        (MediaContainer.Metadata ?? []).flatMap((item): MediaServerLatestItem[] => {
          const type = item.type === 'movie' ? 'movie' : item.type === 'show' ? 'tv' : undefined;
          const { tmdbId } = plexIds(item);
          return type && tmdbId !== undefined ? [{ type, tmdbId, addedAt: (item.addedAt ?? 0) * 1000 }] : [];
        }),
      );
      return newestFirst(items, limit);
    },
    // Photos des comptes Plex : sur plex.tv, en HTTPS, sans jeton (jamais celui du propriétaire hors de son serveur).
    avatarRequest: (avatar) => {
      if (!URL.canParse(avatar)) return null;
      const url = new URL(avatar);
      const onPlexTv = url.hostname === 'plex.tv' || url.hostname.endsWith('.plex.tv');
      return url.protocol === 'https:' && onPlexTv ? { url: url.toString(), headers: {} } : null;
    },
  };
}

// --- Connexion des membres par code PIN (plex.tv) ---

const pinSchema = z.object({
  id: z.number().int(),
  code: z.string().min(1),
  expiresAt: z.string().nullish(),
  authToken: z.string().nullish(),
});

export interface PlexPin {
  id: number;
  code: string;
  /** ms depuis l'époque Unix ; plex.tv donne un code valable environ 30 minutes. */
  expiresAt: number;
}

/** Durée retenue quand plex.tv ne donne pas d'expiration lisible (Seerr abandonne au bout de 15 min). */
const PIN_FALLBACK_TTL_MS = 15 * 60_000;

/** Crée un code PIN « fort » (`POST /api/v2/pins?strong=true`). */
export async function createPlexPin(options: PlexOptions, now = Date.now()): Promise<PlexPin> {
  const pin = await plexTvClient(options).post('/api/v2/pins', pinSchema, { query: { strong: 'true' } });
  return { id: pin.id, code: pin.code, expiresAt: Date.parse(pin.expiresAt ?? '') || now + PIN_FALLBACK_TTL_MS };
}

/** Fenêtre app.plex.tv où le membre valide le code (forme de Seerr). */
export const plexAuthUrl = (clientId: string, code: string) =>
  `https://app.plex.tv/auth/#!?${new URLSearchParams({
    clientID: clientId,
    code,
    'context[device][product]': PLEX_PRODUCT,
  }).toString()}`;

/** Jeton du compte une fois le code validé dans la fenêtre Plex, `null` tant qu'il ne l'est pas. */
export async function checkPlexPin(options: PlexOptions, pin: Pick<PlexPin, 'id' | 'code'>): Promise<string | null> {
  const { authToken } = await plexTvClient(options).get(`/api/v2/pins/${pin.id}`, pinSchema, {
    query: { code: pin.code },
  });
  return authToken || null;
}
