import { arrLabel } from '../../shared/arr-servers.ts';
import type { MediaType } from '../../shared/media.ts';
import type { ApproveRequestInput, SendOptions } from '../../shared/requests.ts';
import type { Data } from '../db/index.ts';
import { arrKindOf, listArrOptions } from '../integrations/arr.ts';
import { HttpError, NotConfiguredError } from '../lib/api-errors.ts';
import { type ArrServerConfig, listArrServers, serversOf } from './arr-servers.ts';

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

/**
 * Serveurs du type et de la qualité, puis profils et dossiers de l'un d'eux (le serveur par défaut sauf `serverId`) et
 * ses valeurs par défaut. Ni adresse ni clé dans la réponse.
 */
export async function sendOptions(
  data: Sources,
  type: MediaType,
  { is4k = false, serverId }: { is4k?: boolean; serverId?: number } = {},
): Promise<SendOptions> {
  const kind = arrKindOf(type);
  const server = sendServer(data, type, is4k, serverId);
  const options = await listArrOptions(kind, server);
  return {
    servers: serversOf(listArrServers(data), kind, is4k).map(({ id, name, isDefault }) => ({
      id,
      name,
      is4k,
      isDefault,
    })),
    serverId: server.id,
    ...options,
    defaultProfileId: server.qualityProfileId,
    defaultFolder: server.rootFolderPath,
  };
}

/**
 * Profil et dossier choisis par l'approbateur : ils doivent exister sur le serveur d'envoi, sinon 400 et rien n'est
 * envoyé. Sans choix (valeurs du serveur, lots, approbation automatique), aucun appel.
 */
export async function assertSendChoice(
  server: ArrServerConfig,
  { qualityProfileId, rootFolderPath }: ApproveRequestInput,
) {
  if (qualityProfileId === undefined && rootFolderPath === undefined) return;
  const options = await listArrOptions(server.type, server);
  if (qualityProfileId !== undefined && !options.qualityProfiles.some((p) => p.id === qualityProfileId))
    throw new HttpError(400, `Profil de qualité inconnu de ${server.name}`);
  if (rootFolderPath !== undefined && !options.rootFolders.some((f) => f.path === rootFolderPath))
    throw new HttpError(400, `Dossier racine inconnu de ${server.name}`);
}
