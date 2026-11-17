import { asc, count, eq } from 'drizzle-orm';
import { type QuotaOverride, quotaOverrideSchema, type Role } from '../../shared/roles.ts';
import type { Db } from '../db/index.ts';
import { users } from '../db/schema.ts';

export type User = typeof users.$inferSelect;

export type EmbyIdentity = { id: string; name: string; avatar: string | null; isEmbyAdmin: boolean };

export class UsersError extends Error {
  code: 'not_found' | 'last_owner';
  constructor(code: UsersError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const countOwners = (db: Pick<Db, 'select'>) =>
  db.select({ n: count() }).from(users).where(eq(users.role, 'owner')).get()?.n ?? 0;

/**
 * Crée ou rafraîchit le membre après une connexion Emby réussie (nom, avatar, dernière connexion).
 *
 * Règle du propriétaire : tant qu'aucun membre n'est propriétaire, le premier administrateur Emby
 * qui se connecte le devient. Ensuite les autres administrateurs Emby arrivent « Membre », comme tout
 * le monde : seul un propriétaire promeut. Un membre existant garde son rôle à la reconnexion.
 * La transaction est « immediate » : le verrou d'écriture est pris avant la lecture, donc deux
 * connexions simultanées ne peuvent pas créer deux propriétaires.
 */
export function upsertFromEmby(db: Db, identity: EmbyIdentity, now = new Date()): User {
  return db.transaction(
    (tx) => {
      const existing = tx.select().from(users).where(eq(users.id, identity.id)).get();
      const becomesOwner = identity.isEmbyAdmin && countOwners(tx) === 0;
      const profile = { name: identity.name, avatar: identity.avatar, lastLoginAt: now, updatedAt: now };
      if (existing) {
        const role: Role = becomesOwner ? 'owner' : existing.role;
        return tx
          .update(users)
          .set({ ...profile, role })
          .where(eq(users.id, identity.id))
          .returning()
          .get();
      }
      return tx
        .insert(users)
        .values({ id: identity.id, ...profile, role: becomesOwner ? 'owner' : 'member', createdAt: now })
        .returning()
        .get();
    },
    { behavior: 'immediate' },
  );
}

export function getUser(db: Db, id: string): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function listUsers(db: Db): User[] {
  return db.select().from(users).orderBy(asc(users.name)).all();
}

/** Change le rôle d'un membre ; le dernier propriétaire ne peut pas être rétrogradé. */
export function setRole(db: Db, id: string, role: Role, now = new Date()): User {
  return db.transaction(
    (tx) => {
      const user = tx.select().from(users).where(eq(users.id, id)).get();
      if (!user) throw new UsersError('not_found', 'Membre introuvable');
      if (user.role === 'owner' && role !== 'owner' && countOwners(tx) <= 1) {
        throw new UsersError('last_owner', 'Il doit rester au moins un propriétaire');
      }
      return tx.update(users).set({ role, updatedAt: now }).where(eq(users.id, id)).returning().get();
    },
    { behavior: 'immediate' },
  );
}

/** Enregistre les quotas propres au membre, ou `null` pour revenir aux quotas par défaut. */
export function setQuotaOverride(db: Db, id: string, input: unknown, now = new Date()): User {
  const quotaOverride: QuotaOverride | null = input === null ? null : quotaOverrideSchema.parse(input);
  const user = db.update(users).set({ quotaOverride, updatedAt: now }).where(eq(users.id, id)).returning().get();
  if (!user) throw new UsersError('not_found', 'Membre introuvable');
  return user;
}
