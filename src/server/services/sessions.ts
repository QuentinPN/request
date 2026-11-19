import { createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { AuthSession } from '../../shared/auth.ts';
import { sha256Hex } from '../crypto.ts';
import type { Data, Db } from '../db/index.ts';
import { sessions, users } from '../db/schema.ts';
import type { User } from './users.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Au plus une écriture par heure et par session pour prolonger la validité. */
export const SESSION_REFRESH_MS = 3600_000;

/** Le jeton ne quitte jamais le cookie : la base ne garde que son empreinte SHA-256. */
const hashToken = sha256Hex;

/**
 * Ouvre une session. Le jeton en clair n'est renvoyé qu'ici, une seule fois. `deviceName` : nom de l'appareil d'un
 * client natif (Viewer), `null` pour une session de navigateur.
 */
export function createSession(
  db: Db,
  userId: string,
  userAgent: string | null,
  now = new Date(),
  deviceName: string | null = null,
): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({ id: hashToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt, userAgent, deviceName })
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

/**
 * Identifiant public d'une session (liste et révocation de ses sessions) : HMAC-SHA256 de son id en base (l'empreinte
 * du jeton), sous la clé de chiffrement de l'installation, tronqué à 128 bits. Ni le jeton ni son empreinte ne sont
 * exposés ou déductibles : sans la clé, l'identifiant ne permet pas de retrouver la ligne, même avec une copie de la
 * base, et il ne se calcule pas depuis le jeton seul (un préfixe de l'empreinte, lui, si). Recalculé à chaque appel :
 * rien à stocker, aucune migration.
 */
export function publicSessionId(cryptoKey: Buffer, id: string): string {
  return createHmac('sha256', cryptoKey).update(`request:session-id:${id}`).digest('hex').slice(0, 32);
}

/**
 * Familles reconnues dans un `User-Agent`, dans l'ordre où les tester : Edge et Opera se disent aussi Chrome, Chrome se
 * dit aussi Safari, Android se dit Linux, iOS se dit Mac OS X.
 */
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/(?:Firefox|FxiOS)\//, 'Firefox'],
  [/(?:Chrome|CriOS)\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];
const nameIn = (ua: string, families: ReadonlyArray<[RegExp, string]>) =>
  families.find(([pattern]) => pattern.test(ua))?.[1];

/**
 * Résumé lisible d'un `User-Agent` : « Firefox · Windows », sinon son premier produit (« okhttp/4.12.0 »), 64 caractères
 * au plus ; `null` sans en-tête.
 */
export function summarizeUserAgent(ua: string | null): string | null {
  if (!ua?.trim()) return null;
  const known = [nameIn(ua, BROWSERS), nameIn(ua, SYSTEMS)].filter(Boolean);
  return known.length > 0 ? known.join(' · ') : (ua.trim().split(/\s/)[0] ?? '').slice(0, 64);
}

/** Sessions en cours d'un membre, la plus récemment utilisée d'abord. `currentToken` : jeton de la requête. */
export function listUserSessions(
  { db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>,
  userId: string,
  currentToken: string | null,
  now = new Date(),
): AuthSession[] {
  const currentId = currentToken ? hashToken(currentToken) : null;
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastSeenAt))
    .all()
    .map((row) => ({
      id: publicSessionId(cryptoKey, row.id),
      deviceName: row.deviceName,
      userAgent: summarizeUserAgent(row.userAgent),
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      current: row.id === currentId,
    }));
}

/**
 * Révoque la session de ce membre qui porte cet identifiant public ; `false` si aucune ne le porte (session d'un autre
 * membre comprise : seules les siennes sont parcourues, et les expirées, que la liste masque, sont introuvables).
 */
export function revokeUserSession(
  { db, cryptoKey }: Pick<Data, 'db' | 'cryptoKey'>,
  userId: string,
  publicId: string,
  now = new Date(),
): boolean {
  const match = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .all()
    .find((row) => publicSessionId(cryptoKey, row.id) === publicId);
  if (!match) return false;
  db.delete(sessions).where(eq(sessions.id, match.id)).run();
  return true;
}

/** Révoque toutes les sessions d'un membre (« Déconnecter partout », ou compte disparu du serveur multimédia). */
export function revokeAllForUser(db: Pick<Db, 'delete'>, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/**
 * Révoque les sessions des membres dont le compte du serveur multimédia (`accounts`, sa liste complète) n'existe plus
 * ou est désactivé : sans cela, leur session survivrait jusqu'à 30 jours d'inactivité. La liste n'est crue que si elle
 * nomme au moins un compte déjà connu de l'appli (actif ou désactivé, même le seul propriétaire) : une liste vide ou
 * sans aucun compte connu est une réponse fantaisiste, rien n'est révoqué. Un propriétaire absent de la liste n'est
 * déconnecté que si un autre propriétaire y figure encore : l'appli ne s'enferme jamais dehors. Renvoie les nombres de
 * membres déconnectés et de propriétaires épargnés.
 */
export function revokeDepartedMembers(
  db: Db,
  accounts: ReadonlyArray<{ id: string; isAdmin: boolean; isDisabled: boolean }>,
): { revoked: number; sparedOwners: number } {
  const active = new Set(accounts.filter((a) => !a.isDisabled).map((a) => a.id));
  return db.transaction((tx) => {
    const knownAccount =
      accounts.length > 0 &&
      tx
        .select({ id: users.id })
        .from(users)
        .where(
          inArray(
            users.id,
            accounts.map((a) => a.id),
          ),
        )
        .limit(1)
        .get();
    if (!knownAccount) return { revoked: 0, sparedOwners: 0 };
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
