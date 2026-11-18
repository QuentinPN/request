import { asc, count, eq } from 'drizzle-orm';
import { type Member, userPath, type Viewer } from '../../shared/auth.ts';
import type { NotificationPreferences } from '../../shared/notifications.ts';
import { capabilitiesOf, type QuotaOverride, type Role } from '../../shared/roles.ts';
import type { Db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { HttpError } from '../lib/api-errors.ts';

export type User = typeof users.$inferSelect;

/** Photo relayée par l'appli (jamais l'adresse d'Emby ni sa clé), `null` sans photo. */
export const avatarUrlOf = (user: User) => (user.avatar ? userPath(encodeURIComponent(user.id), 'avatar') : null);

export const toViewer = (user: User): Viewer => ({
  id: user.id,
  name: user.name,
  role: user.role,
  capabilities: capabilitiesOf(user.role),
  avatarUrl: avatarUrlOf(user),
});

export const toMember = (user: User): Member => ({
  id: user.id,
  name: user.name,
  role: user.role,
  avatarUrl: avatarUrlOf(user),
  quotaOverride: user.quotaOverride ?? null,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
});

export type EmbyIdentity = { id: string; name: string; avatar: string | null; isEmbyAdmin: boolean };

const USERS_STATUS = { not_found: 404, last_owner: 409 } as const;

/** Refus métier sur les membres ; son statut HTTP est porté par `HttpError`. */
export class UsersError extends HttpError {
  code: keyof typeof USERS_STATUS;
  constructor(code: UsersError['code'], message: string) {
    super(USERS_STATUS[code], message);
    this.name = 'UsersError';
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

export const hasOwner = (db: Db) => countOwners(db) > 0;

/**
 * Import depuis la liste des comptes Emby : crée les membres absents (rôle « Membre »), rafraîchit nom et
 * avatar des autres. Ne promeut jamais et ne touche ni au rôle ni à la dernière connexion d'un membre existant.
 */
export function importFromEmby(
  db: Pick<Db, 'insert'>,
  identity: Omit<EmbyIdentity, 'isEmbyAdmin'>,
  now = new Date(),
): User {
  const profile = { name: identity.name, avatar: identity.avatar, updatedAt: now };
  return db
    .insert(users)
    .values({ id: identity.id, ...profile, role: 'member', createdAt: now, lastLoginAt: null })
    .onConflictDoUpdate({ target: users.id, set: profile })
    .returning()
    .get();
}

export function getUser(db: Db, id: string): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function listUsers(db: Db): User[] {
  return db.select().from(users).orderBy(asc(users.name)).all();
}

/** Change le rôle d'un membre ; le dernier propriétaire ne peut pas être rétrogradé. */
export function setRole(db: Pick<Db, 'transaction'>, id: string, role: Role, now = new Date()): User {
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

/** Modifie un membre et le renvoie ; membre inconnu → `not_found`. */
function updateUser(db: Pick<Db, 'update'>, id: string, values: Partial<typeof users.$inferInsert>): User {
  const user = db.update(users).set(values).where(eq(users.id, id)).returning().get();
  if (!user) throw new UsersError('not_found', 'Membre introuvable');
  return user;
}

/**
 * Enregistre les quotas propres au membre, ou `null` pour revenir aux quotas par défaut. La valeur est déjà
 * validée par `memberUpdateSchema` (qui reprend `quotaOverrideSchema`) : un seul endroit valide.
 */
export function setQuotaOverride(
  db: Pick<Db, 'update'>,
  id: string,
  quotaOverride: QuotaOverride | null,
  now = new Date(),
): User {
  return updateUser(db, id, { quotaOverride, updatedAt: now });
}

/** Adresse et canaux de notification du membre, déjà validés par `notificationPreferencesSchema`. */
export function setNotificationPreferences(
  db: Db,
  id: string,
  preferences: NotificationPreferences,
  now = new Date(),
): User {
  return updateUser(db, id, { ...preferences, updatedAt: now });
}
