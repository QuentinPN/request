import { type Column, sql } from 'drizzle-orm';
import type { MediaKey } from '../../shared/media.ts';

/** `SELECT 1` des sous-requêtes d'existence (`exists` / `notExists`). */
export const one = sql`1`;

/**
 * `(type, tmdb_id) IN (VALUES …)` sur deux colonnes d'une table : lecture par lot d'une page de titres, servie par un
 * index unique `(type, tmdb_id)` (`media`, `blocked_titles`). `keys` ne doit pas être vide.
 */
export function keyPairsIn(typeColumn: Column, tmdbIdColumn: Column, keys: readonly MediaKey[]) {
  const values = sql.join(
    keys.map(({ type, tmdbId }) => sql`(${type}, ${tmdbId})`),
    sql`, `,
  );
  return sql`(${typeColumn}, ${tmdbIdColumn}) IN (VALUES ${values})`;
}
