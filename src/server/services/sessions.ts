import { randomBytes } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db/index.ts';
import { sessions, users } from '../db/schema.ts';
import type { User } from './users.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Au plus une écriture par heure et par session pour prolonger la validité. */
export const SESSION_REFRESH_MS = 3600_000;

/** Le jeton ne quitte jamais le cookie : la base ne garde que son empreinte SHA-256. */
const hashToken = sha256Hex;

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

/** Révoque toutes les sessions d'un membre (« Déconnecter partout », ou compte disparu du serveur multimédia). */
export function revokeAllForUser(db: Pick<Db, 'delete'>, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/**
 * Révoque les sessions des membres dont le compte du serveur multimédia (`accounts`, sa liste complète) n'existe plus
 * ou est désactivé : sans cela, leur session survivrait jusqu'à 30 jours d'inactivité. Une liste sans aucun membre
 * actif non administrateur n'est pas crue (réponse vide ou partielle, et Plex y met toujours son propriétaire : rien
 * n'est révoqué). Un propriétaire absent de la liste n'est déconnecté que si un autre propriétaire y figure encore :
 * l'appli ne s'enferme jamais dehors. Renvoie les nombres de membres déconnectés et de propriétaires épargnés.
 */
export function revokeDepartedMembers(
  db: Db,
  accounts: ReadonlyArray<{ id: string; isAdmin: boolean; isDisabled: boolean }>,
): { revoked: number; sparedOwners: number } {
  const enabled = accounts.filter((a) => !a.isDisabled);
  if (!enabled.some((a) => !a.isAdmin)) return { revoked: 0, sparedOwners: 0 };
  const active = new Set(enabled.map((a) => a.id));
  return db.transaction((tx) => {
    const departed = tx
      .selectDistinct({ id: users.id, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .all()
      .filter((member) => !active.has(member.id));
    const ownerRemains = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'owner'))
      .all()
      .some((owner) => active.has(owner.id));
    const result = { revoked: 0, sparedOwners: 0 };
    for (const member of departed) {
      if (member.role === 'owner' && !ownerRemains) result.sparedOwners++;
      else {
        revokeAllForUser(tx, member.id);
        result.revoked++;
      }
    }
    return result;
  });
}

/** Supprime les sessions expirées ; renvoie leur nombre. */
export function purgeExpired(db: Db, now = new Date()): number {
  return db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes;
}
