import { z } from 'zod';
import type { SeerrImportInput } from '../../shared/import.ts';
import { createClient } from './http.ts';

/** Seerr, Jellyseerr ou Overseerr : même API (`/api/v1`, clé dans `X-Api-Key`). Voir docs/integrations.md. */
const SERVICE = 'Seerr';
const PAGE_SIZE = 100;
/** Garde-fou : 1 000 pages de 100 demandes, bien au-delà d'un serveur familial. */
const MAX_PAGES = 1000;

// --- Schémas (tolérants : champs en trop ignorés, champs facultatifs absents acceptés) ---

const name = z.string().nullish();

const userSchema = z.object({
  id: z.number(),
  /** Id Emby ou Jellyfin du compte (Jellyseerr range les comptes Emby ici aussi) ; absent chez Overseerr. */
  jellyfinUserId: name,
  jellyfinUsername: name,
  username: name,
  plexUsername: name,
  displayName: name,
  email: name,
});

/** Statuts numériques de Seerr (`server/constants/media.ts`). */
export const SEERR_REQUEST = { pending: 1, approved: 2, declined: 3, failed: 4, completed: 5 } as const;
export const SEERR_MEDIA_AVAILABLE = 5;

const requestSchema = z.object({
  id: z.number().int(),
  status: z.number().int(),
  type: name,
  is4k: z.boolean().nullish(),
  createdAt: z.string(),
  updatedAt: name,
  media: z
    .object({
      mediaType: name,
      tmdbId: z.number().nullish(),
      tvdbId: z.number().nullish(),
      status: z.number().nullish(),
      status4k: z.number().nullish(),
    })
    .nullish(),
  seasons: z.array(z.object({ seasonNumber: z.number().int() })).nullish(),
  requestedBy: userSchema.nullish(),
});
export type SeerrRequest = z.infer<typeof requestSchema>;
export type SeerrUser = z.infer<typeof userSchema>;

// Chaque demande est validée à part : une seule demande illisible ne fait pas échouer tout l'import.
const pageSchema = z.object({
  pageInfo: z.object({ results: z.number() }),
  results: z.array(z.unknown()),
});

/**
 * Toutes les demandes de Seerr (`filter=all`), page par page. Une demande hors du schéma attendu vaut `null` (comptée
 * comme titre non reconnu) ; un échec de Seerr lève une `IntegrationError` au message lisible, sans la clé.
 */
export async function fetchSeerrRequests({ url, apiKey }: SeerrImportInput): Promise<Array<SeerrRequest | null>> {
  const client = createClient({ service: SERVICE, baseUrl: url, headers: { 'X-Api-Key': apiKey }, timeoutMs: 15_000 });
  const all: Array<SeerrRequest | null> = [];
  // `skip` avance du nombre de demandes reçues : juste même si Seerr plafonne `take` de son côté.
  for (let page = 0, skip = 0; page < MAX_PAGES; page++) {
    const { pageInfo, results } = await client.get('/api/v1/request', pageSchema, {
      query: { take: PAGE_SIZE, skip, filter: 'all' },
    });
    for (const item of results) {
      const parsed = requestSchema.safeParse(item);
      all.push(parsed.success ? parsed.data : null);
    }
    skip += results.length;
    if (results.length === 0 || skip >= pageInfo.results) break;
  }
  return all;
}
