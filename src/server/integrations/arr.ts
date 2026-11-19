import { z } from 'zod';
import { type ArrKind, arrKindLabels } from '../../shared/arr-servers.ts';
import type { ArrTestResult } from '../../shared/setup.ts';
import { createClient, IntegrationError } from './http.ts';

/** Connexion à une instance Radarr ou Sonarr (un serveur de `arr_servers`). */
export interface ArrConfig {
  url: string;
  apiKey: string;
}

export { arrKindOf } from '../../shared/arr-servers.ts';
export type { ArrKind };

export const ARR_SERVICE = arrKindLabels;

const API = '/api/v3';

/** Client HTTP d'une instance : adresse, `X-Api-Key`, base `/api/v3` (la clé ne quitte jamais les en-têtes). */
export function arrClient(kind: ArrKind, config: ArrConfig) {
  const client = createClient({
    service: ARR_SERVICE[kind],
    baseUrl: config.url,
    headers: { 'x-api-key': config.apiKey },
  });
  const at = (path: string) => `${API}${path}`;
  return {
    get: <T>(path: string, schema: z.ZodType<T>, query?: Record<string, string | number | boolean>) =>
      client.get(at(path), schema, query ? { query } : undefined),
    post: <T>(path: string, schema: z.ZodType<T>, body: unknown) => client.post(at(path), schema, { body }),
    put: <T>(path: string, schema: z.ZodType<T>, body: unknown) => client.put(at(path), schema, { body }),
  };
}

/** Erreur « ressource absente » dans le même format que les erreurs HTTP (message lisible, en français). */
export const notFound = (kind: ArrKind, what: string) =>
  new IntegrationError('not_found', ARR_SERVICE[kind], `${what} introuvable chez ${ARR_SERVICE[kind]}`);

/** Certaines versions renvoient un objet, d'autres une liste : on garde le premier élément. */
export const firstOf = <T>(value: T | T[]): T | undefined => (Array.isArray(value) ? value[0] : value);
export const oneOrMany = <T extends z.ZodType>(schema: T) => z.union([schema, z.array(schema)]);

/** Un champ douteux invalide ne casse pas la lecture : il est ignoré. */
export const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/**
 * Ajout idempotent : si la création échoue en 400 (déjà présent), `recover` retrouve l'existant ; sinon l'erreur
 * remonte. Si `recover` échoue ou ne trouve rien, c'est la 400 d'origine qui est relancée, pas l'erreur de la recherche.
 */
export async function createOrRecover<T>(create: () => Promise<T>, recover: () => Promise<T | undefined>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof IntegrationError && error.kind === 'http' && error.status === 400) {
      const existing = await recover().catch(() => undefined);
      if (existing !== undefined) return existing;
    }
    throw error;
  }
}

// --- Étiquettes ---

const tagSchema = z.looseObject({ id: z.number(), label: z.string() });
export interface ArrTag {
  id: number;
  label: string;
}

/** Étiquettes du serveur (id et libellé, les libellés étant en minuscules chez Radarr et Sonarr). */
export async function listTags(kind: ArrKind, config: ArrConfig): Promise<ArrTag[]> {
  const tags = await arrClient(kind, config).get('/tag', z.array(tagSchema));
  return tags.map(({ id, label }) => ({ id, label }));
}

/** Texte accepté dans un libellé d'étiquette (lettres, chiffres, tirets), comme `sanitizeDisplayName` de Seerr. */
const tagText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

/**
 * Étiquette d'un membre sur le serveur, créée au besoin : libellé `<id>-<nom>` comme Seerr. Le libellé exact l'emporte
 * (un identifiant à tirets peut être le préfixe d'un autre) ; à défaut, retrouvée par son préfixe `<id>-` (ou
 * `<id> - `, ancien format de Seerr) : un membre renommé garde son étiquette. Deux envois simultanés qui la créent
 * ensemble se retrouvent (la seconde création, refusée en 400, relit la liste). Tout échec nomme l'étape.
 */
export async function findOrCreateMemberTag(
  kind: ArrKind,
  config: ArrConfig,
  member: { id: string; name: string },
): Promise<number> {
  const id = tagText(member.id);
  const name = tagText(member.name);
  const label = name ? `${id}-${name}` : id;
  try {
    if (!id) throw new IntegrationError('http', ARR_SERVICE[kind], 'identifiant du membre inutilisable');
    const find = async () => {
      const tags = (await listTags(kind, config)).map((tag) => ({ ...tag, label: tag.label.toLowerCase() }));
      return (
        tags.find((tag) => tag.label === label) ??
        tags.find((tag) => tag.label === id || tag.label.startsWith(`${id}-`) || tag.label.startsWith(`${id} - `))
      )?.id;
    };
    const found = await find();
    if (found !== undefined) return found;
    return await createOrRecover(
      async () => (await arrClient(kind, config).post('/tag', tagSchema, { label })).id,
      find,
    );
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    const { status, url } = error;
    throw new IntegrationError(
      error.kind,
      error.service,
      `Création du tag du membre dans ${ARR_SERVICE[kind]} impossible : ${error.message}`,
      { ...(status !== undefined && { status }), ...(url !== undefined && { url }) },
    );
  }
}

/** Étiquettes sans doublon, dans l'ordre. */
export const mergeTags = (...lists: ReadonlyArray<readonly number[]>): number[] => [...new Set(lists.flat())];

// --- Test de connexion (assistant) ---

export const profileSchema = z.looseObject({ id: z.number(), name: z.string() });
const rootFolderSchema = z.looseObject({ id: z.number(), path: z.string(), freeSpace: z.number().catch(0) });
const statusSchema = z.looseObject({ version: z.string() });

/** Ne garde de `{ id, name }` que ces deux champs (profils de qualité ou de langue). */
export const toProfile = ({ id, name }: { id: number; name: string }) => ({ id, name });

export type { ArrTestResult };

export type ArrOptions = Omit<ArrTestResult, 'version'>;

/** Profils de qualité et dossiers racines : les listes déroulantes de l'assistant et de l'approbation. */
export async function listArrOptions(kind: ArrKind, config: ArrConfig): Promise<ArrOptions> {
  const client = arrClient(kind, config);
  const [qualityProfiles, rootFolders] = await Promise.all([
    client.get('/qualityprofile', z.array(profileSchema)),
    client.get('/rootfolder', z.array(rootFolderSchema)),
  ]);
  return {
    qualityProfiles: qualityProfiles.map(toProfile),
    rootFolders: rootFolders.map(({ id, path, freeSpace }) => ({ id, path, freeSpace })),
  };
}

/** Vérifie l'adresse et la clé, et renvoie de quoi alimenter les listes déroulantes. */
export async function testArr(kind: ArrKind, config: ArrConfig): Promise<ArrTestResult> {
  const [status, options, tags] = await Promise.all([
    arrClient(kind, config).get('/system/status', statusSchema),
    listArrOptions(kind, config),
    // Facultatives : sans la liste, le formulaire garde les étiquettes enregistrées sans pouvoir les changer.
    listTags(kind, config).catch(() => undefined),
  ]);
  return { version: status.version, ...options, ...(tags && { tags }) };
}

// --- File de téléchargement ---

export interface QueueItem {
  /** `movieId` (Radarr) ou `seriesId` (Sonarr). */
  externalId: number;
  seasonNumber?: number;
  episodeId?: number;
  /** De 0 à 1. */
  progress: number;
  timeleft: string | null;
  status: string;
}

const queueRecordSchema = z.looseObject({
  movieId: lenient(z.number()),
  seriesId: lenient(z.number()),
  seasonNumber: lenient(z.number()),
  episodeId: lenient(z.number()),
  episode: lenient(z.looseObject({ seasonNumber: lenient(z.number()) })),
  size: z.number().catch(0),
  sizeleft: z.number().catch(0),
  timeleft: z.string().nullish().catch(null),
  status: z.string().catch('unknown'),
});
const queuePageSchema = z.looseObject({
  totalRecords: z.number().catch(0),
  records: z.array(queueRecordSchema),
});

const QUEUE_PAGE_SIZE = 200;
const QUEUE_MAX_PAGES = 50;

/** 1 - reste/taille, borné à [0, 1] ; une taille nulle ou inconnue vaut 0. */
export const queueProgress = (size: number, sizeleft: number) =>
  size > 0 ? Math.min(1, Math.max(0, 1 - sizeleft / size)) : 0;

/**
 * Téléchargements en cours, toutes pages confondues ; les entrées sans film ni série (hors appli) sont ignorées.
 * Sonarr renvoie un enregistrement par épisode : à l'appelant d'agréger par saison. `QUEUE_MAX_PAGES` n'est qu'une
 * limite de sécurité contre une pagination qui ne finirait pas.
 */
export async function getQueue(kind: ArrKind, config: ArrConfig): Promise<QueueItem[]> {
  const client = arrClient(kind, config);
  const items: QueueItem[] = [];
  for (let page = 1; page <= QUEUE_MAX_PAGES; page++) {
    const { totalRecords, records } = await client.get('/queue', queuePageSchema, {
      page,
      pageSize: QUEUE_PAGE_SIZE,
      ...(kind === 'sonarr' && { includeEpisode: true }),
    });
    for (const record of records) {
      const externalId = kind === 'radarr' ? record.movieId : record.seriesId;
      if (externalId === undefined) continue;
      const seasonNumber = record.seasonNumber ?? record.episode?.seasonNumber;
      items.push({
        externalId,
        ...(seasonNumber !== undefined && { seasonNumber }),
        ...(record.episodeId !== undefined && { episodeId: record.episodeId }),
        progress: queueProgress(record.size, record.sizeleft),
        timeleft: record.timeleft ?? null,
        status: record.status,
      });
    }
    if (records.length === 0 || page * QUEUE_PAGE_SIZE >= totalRecords) break;
  }
  return items;
}

// --- Webhooks entrants ---

export interface ArrWebhookEvent {
  /** `deleted` : film, série ou fichier supprimé ; `other` : sans intérêt pour l'appli (Rename, Health…). */
  event: 'download' | 'grab' | 'deleted' | 'test' | 'other';
  tmdbId?: number;
  tvdbId?: number;
  /** Saisons concernées (Sonarr), triées, sans doublon. */
  seasons?: number[];
  /** Le fichier remplace une version moins bonne : à ne pas notifier comme une nouveauté. */
  isUpgrade: boolean;
}

/**
 * `eventType` (en minuscules) → évènement, d'après `WebhookEventType` de Radarr 7.0.3 et Sonarr 4.0.20 [V]. La fin
 * d'import d'un lot de Sonarr (« On Import Complete ») arrive avec `eventType: "Download"`, sans `isUpgrade` : il
 * n'existe pas d'`eventType` `ImportComplete`.
 */
const EVENTS: Record<string, ArrWebhookEvent['event']> = {
  download: 'download',
  grab: 'grab',
  moviedelete: 'deleted',
  moviefiledelete: 'deleted',
  seriesdelete: 'deleted',
  episodefiledelete: 'deleted',
  test: 'test',
};

const mediaSchema = z.looseObject({ tmdbId: lenient(z.number()), tvdbId: lenient(z.number()) });
const webhookSchema = z.looseObject({
  eventType: z.string(),
  isUpgrade: z.boolean().catch(false),
  movie: lenient(mediaSchema),
  series: lenient(mediaSchema),
  episodes: z.array(z.looseObject({ seasonNumber: lenient(z.number()) })).catch([]),
});

/**
 * Normalise un webhook Radarr (`media = 'movie'`) ou Sonarr (`'series'`). Ne lève jamais : un corps illisible
 * ou un évènement sans intérêt (Rename, Health…) donne `event: 'other'`, que l'appelant ignore.
 */
export function parseArrWebhook(body: unknown, media: 'movie' | 'series'): ArrWebhookEvent {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return { event: 'other', isUpgrade: false };
  const { eventType, isUpgrade, episodes } = parsed.data;
  const ids = parsed.data[media];
  const seasons = [
    ...new Set(episodes.flatMap(({ seasonNumber }) => (seasonNumber === undefined ? [] : [seasonNumber]))),
  ];
  seasons.sort((a, b) => a - b);
  return {
    event: EVENTS[eventType.toLowerCase()] ?? 'other',
    ...(ids?.tmdbId !== undefined && { tmdbId: ids.tmdbId }),
    ...(ids?.tvdbId !== undefined && { tvdbId: ids.tvdbId }),
    ...(seasons.length > 0 && { seasons }),
    isUpgrade,
  };
}
