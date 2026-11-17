import { z } from 'zod';
import type { MediaType } from '../../shared/media.ts';
import type { Setting } from '../../shared/settings.ts';
import { createClient } from './http.ts';

export interface TraktConfig extends Setting<'trakt'> {
  /** Remplaçable pour les tests (défaut : l'API publique Trakt). */
  baseUrl?: string;
}

const SERVICE = 'Trakt';
const DEFAULT_BASE_URL = 'https://api.trakt.tv';
const PAGE_SIZE = 100;
/** Garde-fou : au plus 2 000 titres lus (20 pages) ; une réponse sans fin ne boucle pas. */
const MAX_PAGES = 20;

const MESSAGES = {
  unauthorized: 'Client ID Trakt refusé',
  unreachable: 'Trakt injoignable',
  not_found: 'Profil Trakt introuvable ou privé',
};

const rawIds = z.object({ tmdb: z.number().int().positive().nullish() });
const rawItem = z.object({
  type: z.string(),
  movie: z.object({ title: z.string(), year: z.number().int().nullish(), ids: rawIds }).nullish(),
  show: z.object({ title: z.string(), year: z.number().int().nullish(), ids: rawIds }).nullish(),
});

/** Titre d'une liste Trakt ; `tmdbId` absent quand Trakt ne connaît pas l'identifiant TMDB. */
export interface TraktTitle {
  type: MediaType;
  tmdbId: number | null;
  title: string;
  year: number | null;
}

function newClient({ clientId, baseUrl = DEFAULT_BASE_URL }: TraktConfig) {
  return createClient({
    service: SERVICE,
    baseUrl,
    messages: MESSAGES,
    headers: { 'trakt-api-key': clientId, 'trakt-api-version': '2', 'user-agent': 'Request' },
  });
}

/** Vérifie le Client ID (une lecture publique) ; lève une `IntegrationError` au message lisible s'il est refusé. */
export async function testTrakt(config: TraktConfig): Promise<{ ok: true }> {
  await newClient(config).get('/movies/trending', z.array(z.unknown()), { query: { limit: 1 } });
  return { ok: true };
}

/**
 * Liste de souhaits publique d'un utilisateur Trakt (films et séries, saisons et épisodes écartés), page après page
 * jusqu'à la page vide (`truncated` : la limite de pages est atteinte, la suite n'est pas lue). Profil introuvable ou privé → `IntegrationError` `not_found` ou `unauthorized` (voir
 * `testTrakt` pour distinguer une clé refusée d'un profil privé).
 */
export async function fetchTraktWatchlist(
  config: TraktConfig,
  username: string,
): Promise<{ titles: TraktTitle[]; truncated: boolean }> {
  const client = newClient(config);
  const path = `/users/${encodeURIComponent(username)}/watchlist/movie,show/added`;
  const titles: TraktTitle[] = [];
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await client.get(path, z.array(rawItem), { query: { page, limit: PAGE_SIZE } });
    if (items.length === 0) {
      truncated = false;
      break;
    }
    for (const { type, movie, show } of items) {
      const found = type === 'movie' ? movie : type === 'show' ? show : null;
      if (found)
        titles.push({
          type: type === 'movie' ? 'movie' : 'tv',
          tmdbId: found.ids.tmdb ?? null,
          title: found.title,
          year: found.year ?? null,
        });
    }
  }
  return { titles, truncated };
}
