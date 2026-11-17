import { createHash, randomBytes } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { sessions, users } from '../db/schema.ts';
import type { User } from './users.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Au plus une écriture par heure et par session pour prolonger la validité. */
export const SESSION_REFRESH_MS = 3600_000;

/** Le jeton ne quitte jamais le cookie : la base ne garde que son empreinte SHA-256. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Ouvre une session. Le jeton en clair n'est renvoyé qu'ici, une seule fois. */
export function createSession(
  db: Db,
  userId: string,
  userAgent: string | null,
  now = new Date(),
): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({ id: hashToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt, userAgent })
    .run();
  return { token, expiresAt };
}

/** Renvoie le membre de la session, ou `null` si le jeton est inconnu, révoqué ou expiré. Expiration glissante. */
export function validateSession(db: Db, token: string, now = new Date()): User | null {
  const id = hashToken(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row || row.session.expiresAt.getTime() <= now.getTime()) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() >= SESSION_REFRESH_MS) {
    db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, id))
      .run();
  }
  return row.user;
}

export function revokeSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, hashToken(token)))
    .run();
}

export function revokeAllForUser(db: Db, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/** Supprime les sessions expirées ; renvoie leur nombre. */
export function purgeExpired(db: Db, now = new Date()): number {
  return db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes;
}
