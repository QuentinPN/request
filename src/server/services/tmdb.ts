import {
  keyOf,
  type MediaDetails,
  type MediaKey,
  type MediaSummary,
  type MediaType,
  mediaDetailsSchema,
} from '../../shared/media.ts';
import { tmdbLocaleSchema } from '../../shared/tmdb-locale.ts';
import type { Data } from '../db/index.ts';
import { IntegrationError } from '../integrations/http.ts';
import { createTmdb, type TmdbClient } from '../integrations/tmdb.ts';
import { HttpError, NotConfiguredError, parseUpstream } from '../lib/api-errors.ts';
import { getSetting } from './settings.ts';

/** Lecture TMDB d'un titre (ou d'une personne, d'une saga : `message`) : inconnu de TMDB → 404, les autres erreurs passent. */
export async function orTitleNotFound<T>(read: () => Promise<T>, message = 'Titre introuvable'): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === 'not_found') throw new HttpError(404, message);
    throw err;
  }
}

/** Fiche TMDB validée (fiche titre, création d'une demande) ; un titre inconnu de TMDB → 404 « Titre introuvable ». */
export const loadDetails = (tmdb: TmdbClient, type: MediaType, id: number): Promise<MediaDetails> =>
  orTitleNotFound(async () => parseUpstream('TMDB', mediaDetailsSchema, await tmdb.details(type, id)));

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
 * Fournit le client TMDB construit d'après les réglages enregistrés (clé, langue et région). Le client est gardé tant
 * qu'aucun de ces trois ne change (il n'est reconstruit qu'après une modification dans Réglages) ; la clé ne sort
 * jamais de ce module. Lève `NotConfiguredError` si TMDB n'est pas encore configuré.
 */
export function createTmdbProvider(data: Data, baseUrl?: string): () => TmdbClient {
  let current: { id: string; client: TmdbClient } | undefined;
  return () => {
    const setting = getSetting(data.db, data.cryptoKey, 'tmdb');
    if (!setting) throw new NotConfiguredError('TMDB');
    const { language, region } = getSetting(data.db, data.cryptoKey, 'tmdbLocale') ?? tmdbLocaleSchema.parse({});
    const id = JSON.stringify([setting.apiKey, language, region]);
    if (current?.id !== id)
      current = { id, client: createTmdb({ ...setting, language, region, ...(baseUrl && { baseUrl }) }) };
    return current.client;
  };
}
