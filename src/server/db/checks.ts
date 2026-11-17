import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/sqlite-core';

/**
 * `colonne IN ('a', 'b')` écrit en littéraux : une contrainte DDL (`CHECK`, `WHERE` d'un index partiel) n'accepte pas
 * de paramètre, et l'`ON CONFLICT … WHERE` d'une insertion doit reprendre mot pour mot celui de l'index partiel.
 */
export function inLiterals(column: AnyColumn, values: readonly string[]): SQL {
  const literals = values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`));
  return sql`${column} IN (${sql.join(literals, sql.raw(', '))})`;
}

/** `CHECK (colonne IN (...))` généré depuis un tableau de `src/shared` : la liste des valeurs n'existe qu'à un endroit. */
export const enumCheck = (name: string, column: AnyColumn, values: readonly string[]) =>
  check(name, inLiterals(column, values));
