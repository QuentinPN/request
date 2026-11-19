import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ApiKey, ApiKeyCreated, ApiKeyScope } from '../../shared/api-keys.ts';
import { capabilitiesOf } from '../../shared/roles.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db/index.ts';
import { apiKeys, users } from '../db/schema.ts';
import { HttpError } from '../lib/api-errors.ts';
import { MINUTE_MS } from '../lib/time.ts';
import type { User } from './users.ts';

/** Début de toute clé : la reconnaître dans un script ou un détecteur de secrets. */
const KEY_PREFIX = 'ur_';
/** Caractères du secret gardés en clair pour reconnaître une clé dans la liste (30 bits sur 256). */
const VISIBLE_CHARS = 5;
/** `last_used_at` n'est réécrit qu'une fois par minute : une clé très sollicitée ne martèle pas la base. */
export const LAST_USED_REFRESH_MS = MINUTE_MS;

const toApiKey = (row: typeof apiKeys.$inferSelect, createdByName: string): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scope: row.scope,
  createdByName,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

/** Crée une clé : 256 bits aléatoires, seul le hash SHA-256 est gardé. Le secret n'est renvoyé qu'ici, une seule fois. */
export function createApiKey(
  db: Db,
  creator: User,
  name: string,
  scope: ApiKeyScope = 'full',
  now = new Date(),
): ApiKeyCreated {
  const random = randomBytes(32).toString('base64url');
  const secret = `${KEY_PREFIX}${random}`;
  const row = db
    .insert(apiKeys)
    .values({
      name,
      keyHash: sha256Hex(secret),
      prefix: `${KEY_PREFIX}${random.slice(0, VISIBLE_CHARS)}`,
      scope,
      createdBy: creator.id,
      createdAt: now,
    })
    .returning()
    .get();
  return { apiKey: toApiKey(row, creator.name), secret };
}

/** Toutes les clés, révoquées comprises (traçabilité), les plus récentes d'abord. */
export function listApiKeys(db: Db): ApiKey[] {
  return db
    .select({ key: apiKeys, createdByName: users.name })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .all()
    .map(({ key, createdByName }) => toApiKey(key, createdByName));
}

/** Révoque une clé (elle reste listée) ; sans effet si elle l'est déjà. 404 si elle n'existe pas. */
export function revokeApiKey(db: Db, id: number, now = new Date()): void {
  const exists = db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!exists) throw new HttpError(404, 'Clé introuvable');
  db.update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .run();
}

/**
 * Membre derrière une clé reçue et portée de la clé, ou `null` : clé inconnue, révoquée, ou créateur qui n'est plus
 * propriétaire (ses droits actuels font foi). Recherche par hash (index unique). Met `last_used_at` à jour au plus une
 * fois par minute.
 */
export function authenticateApiKey(
  db: Db,
  secret: string,
  now = new Date(),
): { user: User; scope: ApiKeyScope } | null {
  const row = db
    .select({ id: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt, scope: apiKeys.scope, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .where(and(eq(apiKeys.keyHash, sha256Hex(secret)), isNull(apiKeys.revokedAt)))
    .get();
  if (!row || !capabilitiesOf(row.user).isOwner) return null;
  if (!row.lastUsedAt || row.lastUsedAt.getTime() <= now.getTime() - LAST_USED_REFRESH_MS)
    db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)).run();
  return { user: row.user, scope: row.scope };
}
