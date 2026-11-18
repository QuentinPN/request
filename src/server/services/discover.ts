import { keyOf, type MediaKey } from '../../shared/media.ts';
import type { MediaStatus, TitleAvailability } from '../../shared/status.ts';
import type { Data } from '../db/index.ts';
import { requestStatesFor } from './availability.ts';
import { getSetting } from './settings.ts';

/** Statuts affichés (version normale) d'un titre « déjà demandé » : en attente, demandé, en téléchargement. */
const REQUESTED: readonly MediaStatus[] = ['pending', 'requested', 'downloading'];

/**
 * Titres à masquer dans les rangées de Découvrir (réglage `discover`, pour tous), d'après leurs statuts (`statuses`,
 * version normale) : « disponible » = statut normal disponible ; « déjà demandé » = demande en cours ou téléchargement
 * de la version normale, ou demande 4K en cours (une seule requête de plus). Ni la recherche ni la fiche n'en tiennent
 * compte. Rien à masquer : ensemble vide, sans requête.
 */
export function hiddenInDiscover(
  data: Data,
  items: readonly MediaKey[],
  statuses: ReadonlyMap<string, TitleAvailability>,
): Set<string> {
  const setting = getSetting(data.db, data.cryptoKey, 'discover');
  if (!setting || (!setting.hideAvailable && !setting.hideRequested) || items.length === 0) return new Set();
  const requested4k = setting.hideRequested ? requestStatesFor(data.db, items, true) : new Map();
  const isRequested = (status: MediaStatus | undefined) => status !== undefined && REQUESTED.includes(status);
  const hidden = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    const status = statuses.get(key)?.status;
    if (setting.hideAvailable && status === 'available') hidden.add(key);
    if (setting.hideRequested && (isRequested(status) || isRequested(requested4k.get(key)?.status))) hidden.add(key);
  }
  return hidden;
}
