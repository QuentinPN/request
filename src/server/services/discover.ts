import { desc, eq, max, notInArray } from 'drizzle-orm';
import { keyOf, type MediaKey } from '../../shared/media.ts';
import { type Setting, settingSchemas } from '../../shared/settings.ts';
import type { MediaStatus, RequestStatus, TitleAvailability } from '../../shared/status.ts';
import type { Data, Db } from '../db/index.ts';
import { media, requests } from '../db/schema.ts';
import { requestStatesFor } from './availability.ts';
import { getSetting } from './settings.ts';

/** Statuts affichés (version normale) d'un titre « déjà demandé » : en attente, demandé, en téléchargement. */
const REQUESTED: readonly MediaStatus[] = ['pending', 'requested', 'downloading'];

/** Ordre et état des rangées de Découvrir (réglage `discoverLayout`) ; jamais enregistré : l'ordre par défaut. */
export const discoverLayoutOf = (data: Data): Setting<'discoverLayout'> =>
  getSetting(data.db, data.cryptoKey, 'discoverLayout') ?? settingSchemas.discoverLayout.parse({});

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

/** Demandes qui n'ont pas (ou plus) de raison d'être mises en avant : refusées, annulées, en échec d'envoi. */
const NOT_RECENT: RequestStatus[] = ['declined', 'cancelled', 'failed'];
const RECENT_REQUESTS_LIMIT = 20;

/**
 * Titres demandés le plus récemment par n'importe quel membre (rangée « Demandes récentes », visible de tous comme dans
 * Seerr : titres seulement, jamais le demandeur), du plus récent au plus ancien, un titre une seule fois (normal et 4K
 * confondus). Une demande refusée, annulée ou en échec n'y figure pas.
 */
export function recentRequestKeys(db: Pick<Db, 'select'>, limit = RECENT_REQUESTS_LIMIT): MediaKey[] {
  return db
    .select({ type: media.type, tmdbId: media.tmdbId })
    .from(requests)
    .innerJoin(media, eq(media.id, requests.mediaId))
    .where(notInArray(requests.status, NOT_RECENT))
    .groupBy(media.id)
    .orderBy(desc(max(requests.createdAt)), desc(media.id))
    .limit(limit)
    .all();
}
