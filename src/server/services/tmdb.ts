import type { Data } from '../db/index.ts';
import { createTmdb, type TmdbClient } from '../integrations/tmdb.ts';
import { NotConfiguredError } from '../lib/api-errors.ts';
import { getSetting } from './settings.ts';

/**
 * Fournit le client TMDB construit d'après le réglage enregistré. Le client est gardé tant que la clé ne change pas
 * (il n'est reconstruit qu'après une modification dans Réglages) ; la clé ne sort jamais de ce module.
 * Lève `NotConfiguredError` si TMDB n'est pas encore configuré.
 */
export function createTmdbProvider(data: Data, baseUrl?: string): () => TmdbClient {
  let current: { apiKey: string; client: TmdbClient } | undefined;
  return () => {
    const setting = getSetting(data.db, data.cryptoKey, 'tmdb');
    if (!setting) throw new NotConfiguredError('TMDB');
    if (current?.apiKey !== setting.apiKey)
      current = { apiKey: setting.apiKey, client: createTmdb({ ...setting, ...(baseUrl && { baseUrl }) }) };
    return current.client;
  };
}
