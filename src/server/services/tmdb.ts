import {
  keyOf,
  type MediaDetails,
  type MediaKey,
  type MediaSummary,
  type MediaType,
  mediaDetailsSchema,
} from '../../shared/media.ts';
import type { Data } from '../db/index.ts';
import { IntegrationError } from '../integrations/http.ts';
import { createTmdb, type TmdbClient } from '../integrations/tmdb.ts';
import { HttpError, NotConfiguredError, parseUpstream } from '../lib/api-errors.ts';
import { getSetting } from './settings.ts';

/** Fiche TMDB validée (fiche titre, création d'une demande) ; un titre inconnu de TMDB → 404 « Titre introuvable ». */
export async function loadDetails(tmdb: TmdbClient, type: MediaType, id: number): Promise<MediaDetails> {
  try {
    return parseUpstream('TMDB', mediaDetailsSchema, await tmdb.details(type, id));
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === 'not_found') throw new HttpError(404, 'Titre introuvable');
    throw err;
  }
}

/**
 * Résumés TMDB des titres (en cache), indexés par `keyOf` ; un titre (ou TMDB entier, non configuré ou en panne)
 * en échec est simplement absent. Sert les listes de demandes et les notifications.
 */
export async function loadSummaries(
  tmdbOf: () => TmdbClient,
  items: readonly MediaKey[],
): Promise<Map<string, MediaSummary>> {
  const found = new Map<string, MediaSummary>();
  let tmdb: TmdbClient;
  try {
    tmdb = tmdbOf();
  } catch {
    return found;
  }
  const keys = [...new Map(items.map((r) => [keyOf(r), { type: r.type, tmdbId: r.tmdbId }])).values()];
  const settled = await Promise.allSettled(keys.map((k) => tmdb.summary(k.type, k.tmdbId)));
  settled.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled' && key) found.set(keyOf(key), result.value);
  });
  return found;
}

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
