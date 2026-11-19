import { asc, count, eq } from 'drizzle-orm';
import { type Member, type MemberOption, memberRequestKeys, userPath, type Viewer } from '../../shared/auth.ts';
import {
  chosenTypes,
  type NotificationPreferences,
  type NotificationPreferencesView,
  notificationEnabled,
  receivableKinds,
} from '../../shared/notifications.ts';
import {
  type Capabilities,
  capabilitiesOf,
  effectivePermissions,
  memberDeleteRefusal,
  memberEditRefusal,
  type PermissionOverrides,
  permissionOverridesOf,
  type QuotaOverride,
  type Role,
} from '../../shared/roles.ts';
import { type Setting, settingSchemas } from '../../shared/settings.ts';
import type { Data, Db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { HttpError } from '../lib/api-errors.ts';
import { getSetting } from './settings.ts';

export type User = typeof users.$inferSelect;

/** Photo relayée par l'appli (jamais l'adresse d'Emby ni sa clé), `null` sans photo. */
export const avatarUrlOf = (user: User) => (user.avatar ? userPath(encodeURIComponent(user.id), 'avatar') : null);

export const toViewer = (user: User): Viewer => ({
  id: user.id,
  name: user.name,
  role: user.role,
  capabilities: capabilitiesOf(user),
  avatarUrl: avatarUrlOf(user),
});

export const toMemberOption = (user: User): MemberOption => {
  const capabilities = capabilitiesOf(user);
  return {
    id: user.id,
    name: user.name,
    avatarUrl: avatarUrlOf(user),
    ...(Object.fromEntries(memberRequestKeys.map((key) => [key, capabilities[key]])) as Pick<
      MemberOption,
      (typeof memberRequestKeys)[number]
    >),
  };
};

export const toMember = (user: User): Member => ({
  ...toMemberOption(user),
  role: user.role,
  quotaOverride: user.quotaOverride ?? null,
  permissions: user.permissions ?? null,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
});

export type EmbyIdentity = { id: string; name: string; avatar: string | null; isEmbyAdmin: boolean };

const USERS_STATUS = { not_found: 404, forbidden: 403 } as const;

/** Refus métier sur les membres ; son statut HTTP est porté par `HttpError`. */
export class UsersError extends HttpError {
  code: keyof typeof USERS_STATUS;
  constructor(code: UsersError['code'], message: string) {
    super(USERS_STATUS[code], message);
    this.name = 'UsersError';
    this.code = code;
  }
}

export type MemberDefaults = Setting<'memberDefaults'>;
const BUILTIN_DEFAULTS: MemberDefaults = settingSchemas.memberDefaults.parse({});

/** « Droits par défaut » des nouveaux membres (réglage `memberDefaults`), « Membre » sans remplacement sinon. */
export const memberDefaultsOf = ({ db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>): MemberDefaults =>
  getSetting(db, cryptoKey, 'memberDefaults') ?? BUILTIN_DEFAULTS;

/** Rôle et droits d'un membre créé : les droits par défaut, réduits à leur écart au préréglage du rôle. */
const newMember = ({ role, permissions }: MemberDefaults) => ({
  role,
  permissions: permissions && permissionOverridesOf(role, permissions),
});

const countOwners = (db: Pick<Db, 'select'>) =>
  db.select({ n: count() }).from(users).where(eq(users.role, 'owner')).get()?.n ?? 0;

/**
 * Crée ou rafraîchit le membre après une connexion Emby réussie (nom, avatar, dernière connexion).
 *
 * Règle du propriétaire : tant qu'aucun membre n'est propriétaire, le premier administrateur Emby
 * qui se connecte le devient. Ensuite les autres administrateurs Emby arrivent « Membre », comme tout
 * le monde : seul un propriétaire promeut. Un membre existant garde son rôle à la reconnexion.
 * La transaction est « immediate » : le verrou d'écriture est pris avant la lecture, donc deux
 * connexions simultanées ne peuvent pas créer deux propriétaires. Un membre créé reçoit les droits par défaut
 * (`defaults`), jamais le premier propriétaire.
 */
export function upsertFromEmby(
  db: Db,
  identity: EmbyIdentity,
  now = new Date(),
  defaults: MemberDefaults = BUILTIN_DEFAULTS,
): User {
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
        .values({
          id: identity.id,
          ...profile,
          ...(becomesOwner ? { role: 'owner' as const, permissions: null } : newMember(defaults)),
          createdAt: now,
        })
        .returning()
        .get();
    },
    { behavior: 'immediate' },
  );
}

export const hasOwner = (db: Db) => countOwners(db) > 0;

/**
 * Import depuis la liste des comptes Emby : crée les membres absents (droits par défaut, `defaults`), rafraîchit nom et
 * avatar des autres. Ne promeut jamais et ne touche ni au rôle, ni aux droits, ni à la dernière connexion d'un membre
 * existant.
 */
export function importFromEmby(
  db: Pick<Db, 'insert'>,
  identity: Omit<EmbyIdentity, 'isEmbyAdmin'>,
  now = new Date(),
  defaults: MemberDefaults = BUILTIN_DEFAULTS,
): User {
  const profile = { name: identity.name, avatar: identity.avatar, updatedAt: now };
  return db
    .insert(users)
    .values({ id: identity.id, ...profile, ...newMember(defaults), createdAt: now, lastLoginAt: null })
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

/**
 * Supprime un membre, dans la transaction de l'appelant, après la garde (`memberDeleteRefusal`, 403 sinon) ; inconnu →
 * `not_found`. Les clés étrangères font le reste : sessions (le membre est déconnecté), demandes (avec saisons et
 * frise), notifications, signalements, liste, appareils push et clés d'API disparaissent ; ce qu'il a décidé, bloqué,
 * résolu ou commenté reste, sans auteur (`SET NULL`).
 */
export function deleteUser(tx: Pick<Db, 'select' | 'delete'>, actor: Capabilities, actorId: string, id: string): void {
  const user = tx.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw new UsersError('not_found', 'Membre introuvable');
  const refusal = memberDeleteRefusal(actor, actorId, user);
  if (refusal) throw new UsersError('forbidden', refusal);
  tx.delete(users).where(eq(users.id, id)).run();
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

/** Active ou désactive la demande automatique des titres ajoutés à « Ma liste » (le droit se vérifie à l'appelant). */
export function setWatchlistAutoRequest(db: Pick<Db, 'update'>, id: string, enabled: boolean, now = new Date()): User {
  return updateUser(db, id, { watchlistAutoRequest: enabled, updatedAt: now });
}

/** Valeur effective de chaque type de notification que ce membre peut recevoir (seuls ceux-là sont proposés). */
export const notificationTypesOf = (user: User): NotificationPreferencesView['types'] =>
  Object.fromEntries(receivableKinds(user).map((kind) => [kind, notificationEnabled(user.notificationTypes, kind)]));

/**
 * Adresse, canaux et types de notification du membre, déjà validés par `notificationPreferencesSchema`. Un type qu'il ne
 * peut pas recevoir (droit de gestion qu'il n'a pas) est refusé (403) ; ses choix précédents, eux, sont gardés : seul
 * l'écart aux valeurs par défaut est enregistré (`chosenTypes`).
 */
export function setNotificationPreferences(
  db: Db,
  user: User,
  { types, ...channels }: NotificationPreferences,
  now = new Date(),
): User {
  const allowed: readonly string[] = receivableKinds(user);
  if (Object.keys(types ?? {}).some((kind) => !allowed.includes(kind)))
    throw new HttpError(403, 'Vous ne pouvez pas recevoir ce type de notification');
  return updateUser(db, user.id, {
    ...channels,
    ...(types && { notificationTypes: chosenTypes({ ...user.notificationTypes, ...types }) }),
    updatedAt: now,
  });
}

/** Rôle et droits demandés pour un membre ; absent = inchangé. */
export type AccessChange = {
  role?: Exclude<Role, 'owner'>;
  /** Remplacements complets, écart au préréglage du rôle final (`null` : revenir au rôle). */
  permissions?: PermissionOverrides | null;
  /** Droits à accorder (`true`) ou retirer (`false`) par-dessus les droits effectifs (édition en masse). */
  changes?: PermissionOverrides;
};

/**
 * Applique un changement de rôle et de droits à `user`, dans la transaction de l'appelant, après la garde contre
 * l'escalade (`memberEditRefusal`, 403 sinon). Un rôle donné qui change applique son préréglage : les
 * remplacements repartent de zéro (sauf `permissions` donné), puis `changes` s'applique. Seul l'écart au préréglage est
 * enregistré.
 */
export function applyAccessChange(
  tx: Pick<Db, 'update'>,
  actor: Capabilities,
  user: User,
  { role, permissions, changes }: AccessChange,
  now = new Date(),
): User {
  const nextRole = role ?? user.role;
  const kept =
    permissions !== undefined ? permissions : role !== undefined && role !== user.role ? null : user.permissions;
  const wanted = { ...effectivePermissions({ role: nextRole, permissions: kept }), ...changes };
  const next = { role: nextRole, permissions: permissionOverridesOf(nextRole, wanted) };
  const refusal = memberEditRefusal(actor, user, next);
  if (refusal) throw new UsersError('forbidden', refusal);
  return updateUser(tx, user.id, { ...next, updatedAt: now });
}
