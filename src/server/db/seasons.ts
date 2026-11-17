import { seasons, seasons4k } from './schema.ts';

/**
 * Table des saisons d'une qualité : `seasons` (bibliothèque normale) ou `seasons_4k` (serveurs 4K). Mêmes colonnes :
 * la table 4K se lit et s'écrit avec les mêmes requêtes (hors de `schema.ts`, que drizzle-kit lit table par table).
 */
export const seasonsTableOf = (is4k: boolean) => (is4k ? (seasons4k as unknown as typeof seasons) : seasons);
