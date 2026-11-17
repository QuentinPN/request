import { type AnyColumn, sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/sqlite-core';

/**
 * `CHECK (colonne IN (...))` généré depuis un tableau de `src/shared` : la liste des valeurs n'existe qu'à un endroit.
 * Les valeurs sont écrites en littéraux (une contrainte DDL n'accepte pas de paramètre).
 */
export function enumCheck(name: string, column: AnyColumn, values: readonly string[]) {
  const literals = values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`));
  return check(name, sql`${column} IN (${sql.join(literals, sql.raw(', '))})`);
}
