import { arrLabel, hasAnimeRoute } from '../../shared/arr-servers.ts';
import { isAnime, type MediaType } from '../../shared/media.ts';
import { type OverrideRule, type OverrideRuleValues, ruleLayer, rulesOnServer } from '../../shared/override-rules.ts';
import { resolveSendChoice, type SendChoiceInput, type SendOptions } from '../../shared/requests.ts';
import { DEFAULT_SERIES_TYPE, type SeriesType } from '../../shared/settings.ts';
import type { Data } from '../db/index.ts';
import { arrKindOf, findOrCreateMemberTag, mergeTags } from '../integrations/arr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError, NotConfiguredError } from '../lib/api-errors.ts';
import { type ArrServerConfig, arrOptionsOf, getArrServer, listArrServers, serversOf } from './arr-servers.ts';
import { matchingRules } from './override-rules.ts';
import { loadDetails } from './tmdb.ts';

type Sources = Pick<Data, 'db' | 'cryptoKey'>;

/**
 * Serveur d'envoi d'une demande : `serverId` s'il est du bon type et de la bonne qualité (sinon 400), à défaut le
 * serveur par défaut. Aucun serveur → `NotConfiguredError` (503 sur les routes, échec lisible à l'envoi).
 */
export function sendServer(data: Sources, type: MediaType, is4k: boolean, serverId?: number | null): ArrServerConfig {
  const kind = arrKindOf(type);
  const servers = serversOf(listArrServers(data), kind, is4k);
  if (serverId != null) {
    const chosen = servers.find((s) => s.id === serverId);
    if (!chosen) throw new HttpError(400, `Serveur inconnu parmi les serveurs ${arrLabel(kind, is4k)}`);
    return chosen;
  }
  const fallback = servers[0];
  if (!fallback) throw new NotConfiguredError(arrLabel(kind, is4k));
  return fallback;
}

/** Valeurs d'envoi d'un titre sur un serveur, avant le choix de l'approbateur. */
export interface Destination {
  qualityProfileId: number;
  rootFolderPath: string;
  /** Radarr : `null`. */
  seriesType: SeriesType | null;
  languageProfileId: number | null;
  tags: number[];
}

/**
 * Valeurs par défaut d'un serveur pour un titre. Une série d'animation (`anime`) d'un serveur qui route les animes
 * prend ses réglages anime, champ par champ (un champ non renseigné garde celui du serveur) ; ses étiquettes anime
 * remplacent celles du serveur, comme chez Seerr.
 */
export function destinationOf(server: ArrServerConfig, anime: boolean): Destination {
  const routed = anime && hasAnimeRoute(server);
  return {
    qualityProfileId: (routed && server.animeQualityProfileId) || server.qualityProfileId,
    rootFolderPath: (routed && server.animeRootFolderPath) || server.rootFolderPath,
    seriesType: (routed && server.animeSeriesType) || server.seriesType,
    languageProfileId: (routed && server.animeLanguageProfileId) || server.languageProfileId,
    tags: routed ? server.animeTags : server.tags,
  };
}

/**
 * Le titre est-il une série d'animation (mot-clé TMDB, comme Seerr) ? Seulement lu si le serveur route les animes :
 * sans réglage anime, aucun appel à TMDB. TMDB muet alors qu'il faut trancher : l'erreur remonte (envoi en échec,
 * relançable) plutôt que d'envoyer l'anime dans le mauvais dossier.
 */
export async function isAnimeTitle(
  tmdb: () => TmdbClient,
  server: ArrServerConfig,
  type: MediaType,
  tmdbId: number,
): Promise<boolean> {
  if (type !== 'tv' || !hasAnimeRoute(server)) return false;
  return isAnime(await loadDetails(tmdb(), type, tmdbId));
}

/**
 * Comme `isAnimeTitle`, mais TMDB muet donne « pas un anime » : l'approbation et la fenêtre d'options ne sont pas
 * bloquées (l'envoi, lui, relit et échoue en relançable si TMDB reste muet).
 */
export const isAnimeTitleOrDefault = (...args: Parameters<typeof isAnimeTitle>) =>
  isAnimeTitle(...args).catch(() => false);

/**
 * Étiquettes envoyées avec un titre : celles de la destination, celles des règles de surcharge qui jouent sur ce serveur,
 * plus celle du membre si le serveur le demande ; sans doublon.
 */
export async function tagsToSend(
  server: ArrServerConfig,
  destination: Destination,
  member: { id: string; name: string } | null,
  rules: readonly Pick<OverrideRule, 'serverId' | 'tags'>[] = [],
): Promise<number[]> {
  const tags = mergeTags(destination.tags, ...rulesOnServer(rules, server.id).map((rule) => rule.tags));
  if (!server.tagRequester || !member) return tags;
  return mergeTags(tags, [await findOrCreateMemberTag(server.type, server, member)]);
}

/**
 * Serveurs du type et de la qualité, puis profils et dossiers de l'un d'eux et ses valeurs par défaut pour le titre
 * `tmdbId` : règles de surcharge qui valent pour lui, puis réglages anime d'une série d'animation. Serveur : `serverId`,
 * sinon celui de la première règle, sinon le serveur par défaut (`resolveSendChoice`). Ni clé ni adresse de connexion
 * dans la réponse, seulement l'adresse externe.
 */
export async function sendOptions(
  data: Sources,
  tmdb: () => TmdbClient,
  type: MediaType,
  { is4k = false, serverId, tmdbId }: { is4k?: boolean; serverId?: number; tmdbId?: number } = {},
): Promise<SendOptions> {
  const kind = arrKindOf(type);
  const rules = tmdbId === undefined ? [] : await matchingRules(data, tmdb, type, is4k, tmdbId);
  const levels = { approver: { serverId }, rules: rules.map(ruleLayer) };
  const server = sendServer(data, type, is4k, resolveSendChoice(levels).serverId);
  const anime = tmdbId !== undefined && (await isAnimeTitleOrDefault(tmdb, server, type, tmdbId));
  const destination = destinationOf(server, anime);
  const shown = resolveSendChoice({ ...levels, defaults: destination }, server.id);
  const options = await arrOptionsOf(data.db, server);
  return {
    servers: serversOf(listArrServers(data), kind, is4k).map(({ id, name, isDefault, externalUrl }) => ({
      id,
      name,
      is4k,
      isDefault,
      externalUrl,
    })),
    serverId: server.id,
    ...options,
    defaultProfileId: shown.qualityProfileId ?? destination.qualityProfileId,
    defaultFolder: shown.rootFolderPath ?? destination.rootFolderPath,
    defaultSeriesType: type === 'tv' ? (shown.seriesType ?? DEFAULT_SERIES_TYPE) : null,
    anime: anime && hasAnimeRoute(server),
    rules: rulesOnServer(rules, server.id).map(({ id, name }) => ({ id, name })),
  };
}

/**
 * Profil et dossier choisis (approbateur, demande avancée) : ils doivent exister sur le serveur d'envoi, sinon 400 et
 * rien n'est enregistré ni envoyé. Sans choix (valeurs du serveur, lots, approbation automatique), aucun appel.
 * Listes lues en cache (`arrOptionsOf`), relues du serveur si le cache est vide.
 */
export async function assertSendChoice(
  data: Sources,
  server: ArrServerConfig,
  { qualityProfileId, rootFolderPath }: SendChoiceInput,
) {
  if (qualityProfileId === undefined && rootFolderPath === undefined) return;
  const options = await arrOptionsOf(data.db, server);
  if (qualityProfileId !== undefined && !options.qualityProfiles.some((p) => p.id === qualityProfileId))
    throw new HttpError(400, `Profil de qualité inconnu de ${server.name}`);
  if (rootFolderPath !== undefined && !options.rootFolders.some((f) => f.path === rootFolderPath))
    throw new HttpError(400, `Dossier racine inconnu de ${server.name}`);
}

/**
 * Cible d'une règle de surcharge : serveur du type de la règle (sinon 400), profil et dossier existant sur ce serveur
 * (`assertSendChoice`, comme la demande avancée). Inchangés depuis `stored` : pas revalidés, le serveur peut être en
 * panne (activer, renommer, réordonner).
 */
export async function assertRuleTarget(data: Sources, values: OverrideRuleValues, stored?: OverrideRule | null) {
  const server = getArrServer(data, values.serverId);
  if (!server || server.type !== arrKindOf(values.type))
    throw new HttpError(400, 'Serveur inconnu ou d’un autre type que la règle');
  if (
    stored?.serverId === values.serverId &&
    stored.qualityProfileId === values.qualityProfileId &&
    stored.rootFolderPath === values.rootFolderPath
  )
    return;
  await assertSendChoice(data, server, {
    qualityProfileId: values.qualityProfileId ?? undefined,
    rootFolderPath: values.rootFolderPath ?? undefined,
  });
}
