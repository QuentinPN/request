import { describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db/index.ts';
import {
  createSession,
  purgeExpired,
  revokeAllForUser,
  revokeSession,
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
  validateSession,
} from '../src/server/services/sessions.ts';
import {
  getUser,
  listUsers,
  setQuotaOverride,
  setRole,
  UsersError,
  upsertFromEmby,
} from '../src/server/services/users.ts';
import { capabilitiesOf, quotaOverrideSchema, roleLabels, roles } from '../src/shared/roles.ts';

const emby = (id: string, isEmbyAdmin = false) => ({ id, name: `Nom ${id}`, avatar: null, isEmbyAdmin });
const hour = 3600_000;

describe('rôles', () => {
  it('dérivent les droits du rôle', () => {
    expect(roles.map((r) => roleLabels[r])).toEqual(['Membre', 'Approbation auto', 'Gestionnaire', 'Propriétaire']);
    expect(capabilitiesOf('member')).toEqual({
      canRequest: true,
      autoApprove: false,
      canManageRequests: false,
      canManageUsers: false,
      isOwner: false,
      quotaExempt: false,
    });
    expect(capabilitiesOf('auto_approve')).toMatchObject({
      autoApprove: true,
      canManageRequests: false,
      quotaExempt: false,
    });
    expect(capabilitiesOf('manager')).toMatchObject({
      autoApprove: true,
      canManageRequests: true,
      canManageUsers: false,
      quotaExempt: true,
    });
    expect(capabilitiesOf('owner')).toMatchObject({
      canManageRequests: true,
      canManageUsers: true,
      isOwner: true,
      quotaExempt: true,
    });
  });
});

describe('migrations des membres', () => {
  it('créent users et sessions sur une base neuve', () => {
    const db = openDb(':memory:');
    const names = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name in ('users', 'sessions')")
      .all();
    expect(names).toHaveLength(2);
  });
});

describe('membres', () => {
  it('nomme propriétaire le premier administrateur Emby seulement', () => {
    const db = openDb(':memory:');
    expect(upsertFromEmby(db, emby('a', true)).role).toBe('owner');
    // Les administrateurs suivants restent « Membre » tant qu'un propriétaire ne les promeut pas.
    expect(upsertFromEmby(db, emby('b', true)).role).toBe('member');
    expect(upsertFromEmby(db, emby('c')).role).toBe('member');
    expect(listUsers(db).filter((u) => u.role === 'owner')).toHaveLength(1);
  });

  it("ne nomme personne propriétaire tant qu'aucun administrateur ne s'est connecté", () => {
    const db = openDb(':memory:');
    expect(upsertFromEmby(db, emby('a')).role).toBe('member');
    expect(upsertFromEmby(db, emby('b', true)).role).toBe('owner');
  });

  it('promeut un membre existant devenu administrateur quand il n’y a pas de propriétaire', () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, emby('a'));
    expect(upsertFromEmby(db, emby('a', true)).role).toBe('owner');
  });

  it('garde le rôle à la reconnexion et rafraîchit le profil', () => {
    const db = openDb(':memory:');
    const t0 = new Date('2026-01-01T10:00:00Z');
    const t1 = new Date(t0.getTime() + hour);
    upsertFromEmby(db, emby('a', true), t0);
    upsertFromEmby(db, emby('b'), t0);
    setRole(db, 'b', 'manager');
    const again = upsertFromEmby(
      db,
      { id: 'b', name: 'Nouveau nom', avatar: 'http://emby/b.png', isEmbyAdmin: false },
      t1,
    );
    expect(again).toMatchObject({ role: 'manager', name: 'Nouveau nom', avatar: 'http://emby/b.png' });
    expect(again.createdAt).toEqual(t0);
    expect(again.lastLoginAt).toEqual(t1);
    // Un propriétaire n'est jamais rétrogradé par une reconnexion.
    expect(upsertFromEmby(db, emby('a', false)).role).toBe('owner');
  });

  it('protège le dernier propriétaire', () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, emby('a', true));
    upsertFromEmby(db, emby('b'));
    expect(() => setRole(db, 'a', 'manager')).toThrow(UsersError);
    expect(getUser(db, 'a')?.role).toBe('owner');

    setRole(db, 'b', 'owner');
    expect(setRole(db, 'a', 'manager').role).toBe('manager');
    expect(() => setRole(db, 'b', 'member')).toThrowError('Il doit rester au moins un propriétaire');
    expect(() => setRole(db, 'inconnu', 'member')).toThrowError('Membre introuvable');
  });

  it('enregistre et efface les quotas propres au membre', () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, emby('a'));
    expect(getUser(db, 'a')?.quotaOverride).toBeNull();

    const saved = setQuotaOverride(db, 'a', { movies: { limit: 5, days: 7 }, seasons: null });
    expect(saved.quotaOverride).toEqual({ movies: { limit: 5, days: 7 }, seasons: null });
    expect(getUser(db, 'a')?.quotaOverride).toEqual(saved.quotaOverride);

    expect(setQuotaOverride(db, 'a', null).quotaOverride).toBeNull();
    expect(() => setQuotaOverride(db, 'inconnu', null)).toThrowError('Membre introuvable');
  });

  it('valident les quotas une seule fois, dans le schéma partagé', () => {
    expect(quotaOverrideSchema.parse({ movies: { limit: 5, days: 7 } })).toEqual({
      movies: { limit: 5, days: 7 },
      seasons: null,
    });
    expect(quotaOverrideSchema.safeParse({ movies: { limit: -1, days: 7 } }).success).toBe(false);
    expect(quotaOverrideSchema.safeParse({ seasons: { limit: 2, days: 0 } }).success).toBe(false);
  });
});

describe('sessions', () => {
  const setup = () => {
    const db = openDb(':memory:');
    upsertFromEmby(db, emby('a', true));
    return db;
  };
  const t0 = new Date('2026-01-01T10:00:00Z');
  const row = (db: ReturnType<typeof openDb>) =>
    db.$client.prepare('select id, expires_at, last_seen_at, user_agent from sessions').get() as {
      id: string;
      expires_at: number;
      last_seen_at: number;
      user_agent: string | null;
    };

  it('ne stockent jamais le jeton en clair', () => {
    const db = setup();
    const { token, expiresAt } = createSession(db, 'a', 'Firefox', t0);
    expect(token).toHaveLength(43);
    expect(expiresAt).toEqual(new Date(t0.getTime() + SESSION_TTL_MS));
    const stored = row(db);
    expect(stored.id).not.toBe(token);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.$client.prepare('select * from sessions').all())).not.toContain(token);
    expect(stored.user_agent).toBe('Firefox');
    expect(createSession(db, 'a', null, t0).token).not.toBe(token);
  });

  it('valident un jeton connu et rejettent les autres', () => {
    const db = setup();
    const { token } = createSession(db, 'a', null, t0);
    expect(validateSession(db, token, t0)?.id).toBe('a');
    expect(validateSession(db, 'inconnu', t0)).toBeNull();
    expect(validateSession(db, token.slice(0, -1), t0)).toBeNull();
  });

  it('expirent après 30 jours sans activité', () => {
    const db = setup();
    const { token, expiresAt } = createSession(db, 'a', null, t0);
    expect(validateSession(db, token, new Date(expiresAt.getTime() - 1000))?.id).toBe('a');
    // Une session qui n'a pas été vue entre-temps (la précédente a été prolongée) échoit pile à 30 jours.
    const idle = createSession(db, 'a', null, t0).token;
    expect(validateSession(db, idle, expiresAt)).toBeNull();
  });

  it('prolongent la validité au plus une fois par heure', () => {
    const db = setup();
    const { token } = createSession(db, 'a', null, t0);
    const initial = row(db).expires_at;

    validateSession(db, token, new Date(t0.getTime() + SESSION_REFRESH_MS - 1000));
    expect(row(db).expires_at).toBe(initial);

    const later = new Date(t0.getTime() + SESSION_REFRESH_MS);
    validateSession(db, token, later);
    expect(row(db).last_seen_at).toBe(later.getTime() / 1000);
    expect(row(db).expires_at).toBe((later.getTime() + SESSION_TTL_MS) / 1000);

    // Au-delà de l'échéance initiale, la session prolongée reste valide.
    const afterOriginalExpiry = new Date(t0.getTime() + SESSION_TTL_MS + hour / 2);
    expect(validateSession(db, token, afterOriginalExpiry)?.id).toBe('a');
  });

  it('se révoquent une par une ou toutes pour un membre', () => {
    const db = setup();
    upsertFromEmby(db, emby('b'));
    const a1 = createSession(db, 'a', null, t0).token;
    const a2 = createSession(db, 'a', null, t0).token;
    const b1 = createSession(db, 'b', null, t0).token;

    revokeSession(db, a1);
    expect(validateSession(db, a1, t0)).toBeNull();
    expect(validateSession(db, a2, t0)?.id).toBe('a');

    revokeAllForUser(db, 'a');
    expect(validateSession(db, a2, t0)).toBeNull();
    expect(validateSession(db, b1, t0)?.id).toBe('b');
  });

  it('purgent les sessions expirées et suivent la suppression du membre', () => {
    const db = setup();
    createSession(db, 'a', null, t0);
    const fresh = createSession(db, 'a', null, new Date(t0.getTime() + 10 * 24 * 3600_000)).token;
    expect(purgeExpired(db, new Date(t0.getTime() + SESSION_TTL_MS))).toBe(1);
    expect(validateSession(db, fresh, t0)?.id).toBe('a');

    db.$client.prepare("delete from users where id = 'a'").run();
    expect(db.$client.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
  });
});
