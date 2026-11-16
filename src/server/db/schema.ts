import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Réglages clé/valeur : `value` est du JSON validé par Zod, les champs secrets y sont chiffrés. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});
