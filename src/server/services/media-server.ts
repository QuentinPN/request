import { createHmac } from 'node:crypto';
import { count } from 'drizzle-orm';
import { mediaServerKindLabels, type Setting } from '../../shared/settings.ts';
import type { Data } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { jellyfinServer } from '../integrations/jellyfin.ts';
import { embyServer, type MediaServer } from '../integrations/media-server.ts';
import { type PlexOptions, plexServer } from '../integrations/plex.ts';
import { HttpError } from '../lib/api-errors.ts';
import { getMediaServer } from './settings.ts';

/** Implémentation du type choisi, pour ce réglage (enregistré, ou seulement en test dans l'assistant). */
export function createMediaServer(config: Setting<'mediaServer'>, plex: PlexOptions): MediaServer {
  if (config.kind === 'jellyfin') return jellyfinServer(config);
  if (config.kind === 'plex') return plexServer(config, plex);
  return embyServer(config);
}

/**
 * Identifiant d'appareil de cette installation auprès de plex.tv (`X-Plex-Client-Identifier`) : stable sans rien
 * enregistrer, tiré de la clé de chiffrement, qui ne sort jamais (une empreinte HMAC ne la révèle pas).
 */
const plexClientId = (cryptoKey: Buffer) =>
  createHmac('sha256', cryptoKey).update('request:plex-client-identifier').digest('hex').slice(0, 32);

/**
 * Accès au serveur multimédia : `current()` relit le réglage à chaque appel (un changement dans Réglages vaut tout de
 * suite), `null` tant que rien n'est configuré. `plexTvUrl` : plex.tv remplacé dans les tests.
 */
export function createMediaServers(data: Data, upstreams: { plexTvUrl?: string } = {}) {
  const plex: PlexOptions = {
    clientId: plexClientId(data.cryptoKey),
    ...(upstreams.plexTvUrl && { plexTvUrl: upstreams.plexTvUrl }),
  };
  const current = (): MediaServer | null => {
    const config = getMediaServer(data.db, data.cryptoKey);
    return config && createMediaServer(config, plex);
  };
  return {
    plex,
    current,
    of: (config: Setting<'mediaServer'>) => createMediaServer(config, plex),
    /** Indispensable à la connexion des membres et à leur import. */
    require: (): MediaServer => {
      const server = current();
      if (!server) throw new HttpError(409, "Aucun serveur multimédia n'est encore configuré");
      return server;
    },
  };
}

export type MediaServers = ReturnType<typeof createMediaServers>;

/** Nom du serveur multimédia choisi (« Jellyfin »), lu à chaque appel ; « le serveur multimédia » s'il n'y en a pas. */
export function mediaServerName({ db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>): string {
  const config = getMediaServer(db, cryptoKey);
  return config ? mediaServerKindLabels[config.kind] : 'le serveur multimédia';
}

/** Des membres existent : changer de type de serveur casserait leurs comptes, liés aux ids de l'ancien. */
export const hasMembers = ({ db }: Pick<Data, 'db'>) => (db.select({ n: count() }).from(users).get()?.n ?? 0) > 0;
