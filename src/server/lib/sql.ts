import { sql } from 'drizzle-orm';

/** `SELECT 1` des sous-requêtes d'existence (`exists` / `notExists`). */
export const one = sql`1`;
