import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type QuotaOverride, roles } from '../../shared/roles.ts';

/** Réglages clé/valeur : `value` est du JSON validé par Zod, les champs secrets y sont chiffrés. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/** Membres, identifiés par leur id Emby. `quotaOverride` : JSON `QuotaOverride`, `null` = quotas par défaut. */
export const users = sqliteTable('users', {
  id: text().primaryKey(),
  name: text().notNull(),
  avatar: text(),
  role: text({ enum: roles }).notNull().default('member'),
  quotaOverride: text({ mode: 'json' }).$type<QuotaOverride>(),
  createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  lastLoginAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/** Sessions : `id` est le hash SHA-256 du jeton du cookie, jamais le jeton lui-même. */
export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer({ mode: 'timestamp' }).notNull(),
  lastSeenAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  userAgent: text(),
});
