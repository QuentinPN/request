import type { MediaType } from '../../shared/media.ts';
import type { ApproveRequestInput, SendOptions } from '../../shared/requests.ts';
import type { Data } from '../db/index.ts';
import { ARR_SERVICE, arrKindOf, listArrOptions } from '../integrations/arr.ts';
import { HttpError, NotConfiguredError } from '../lib/api-errors.ts';
import { getSetting } from './settings.ts';

/**
 * Profils et dossiers de Radarr ou Sonarr, lus avec les réglages enregistrés, et leurs valeurs par défaut. Ni adresse
 * ni clé dans la réponse. Service pas encore configuré → `NotConfiguredError` (503).
 */
export async function sendOptions({ db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>, type: MediaType) {
  const kind = arrKindOf(type);
  const setting = getSetting(db, cryptoKey, kind);
  if (!setting) throw new NotConfiguredError(ARR_SERVICE[kind]);
  const options = await listArrOptions(kind, setting);
  return {
    ...options,
    defaultProfileId: setting.qualityProfileId,
    defaultFolder: setting.rootFolderPath,
  } satisfies SendOptions;
}

/**
 * Profil et dossier choisis par l'approbateur : ils doivent exister chez Radarr/Sonarr, sinon 400 et rien n'est
 * envoyé. Sans choix (réglages par défaut, lots, approbation automatique), aucun appel.
 */
export async function assertSendChoice(
  data: Pick<Data, 'db' | 'cryptoKey'>,
  type: MediaType,
  { qualityProfileId, rootFolderPath }: ApproveRequestInput,
) {
  if (qualityProfileId === undefined && rootFolderPath === undefined) return;
  const options = await sendOptions(data, type);
  const service = ARR_SERVICE[arrKindOf(type)];
  if (qualityProfileId !== undefined && !options.qualityProfiles.some((p) => p.id === qualityProfileId))
    throw new HttpError(400, `Profil de qualité inconnu de ${service}`);
  if (rootFolderPath !== undefined && !options.rootFolders.some((f) => f.path === rootFolderPath))
    throw new HttpError(400, `Dossier racine inconnu de ${service}`);
}
