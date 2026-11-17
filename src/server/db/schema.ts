import { sql } from 'drizzle-orm';
import { check, customType, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type QuotaOverride, quotaOverrideSchema, roles } from '../../shared/roles.ts';
import { enumCheck } from './checks.ts';

/**
 * JSON validé à la lecture par `quotaOverrideSchema` : une valeur illisible ou hors schéma (base éditée à la main,
 * ancien format) vaut `null` (quotas par défaut) et est journalisée, au lieu de faire échouer la connexion
 * ou la liste des membres.
 */
const quotaOverrideJson = customType<{ data: QuotaOverride | null; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (stored) => {
    try {
      const parsed = quotaOverrideSchema.safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON invalide : traité comme un format inconnu, ci-dessous.
    }
    console.error('quota_override illisible en base : quotas par défaut appliqués');
    return null;
  },
});

/** Réglages clé/valeur : `value` est du JSON validé par Zod, les champs secrets y sont chiffrés. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/**
 * Membres, identifiés par leur id Emby. `quotaOverride` : JSON `QuotaOverride`, `null` = quotas par défaut.
 * `lastLoginAt` : `null` tant que le membre (importé depuis Emby) ne s'est jamais connecté.
 */
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    avatar: text(),
    role: text({ enum: roles }).notNull().default('member'),
    quotaOverride: quotaOverrideJson(),
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastLoginAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    enumCheck('users_role_check', table.role, roles),
    check('users_quota_override_json_check', sql`${table.quotaOverride} IS NULL OR json_valid(${table.quotaOverride})`),
  ],
);

/** Sessions : `id` est le hash SHA-256 du jeton du cookie, jamais le jeton lui-même. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    lastSeenAt: integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    userAgent: text(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
);
