import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrationsFolder, openDataDir, openDb } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import {
  getUser,
  importFromEmby,
  listUsers,
  toMember,
  type User,
  upsertFromEmby,
} from '../src/server/services/users.ts';
import { roles } from '../src/shared/roles.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
afterEach(() => vi.restoreAllMocks());

const insertUser = (db: ReturnType<typeof openDb>, role: string, quotaOverride: string | null = null) =>
  db.$client
    .prepare('insert into users (id, name, role, quota_override) values (?, ?, ?, ?)')
    .run(`u-${role}`, `Nom ${role}`, role, quotaOverride);

describe('index des sessions', () => {
  /** Plan d'exécution de la requête Drizzle (même SQL et mêmes paramètres que ceux envoyés à SQLite). */
  const plan = (db: ReturnType<typeof openDb>, query: { toSQL: () => { sql: string; params: unknown[] } }) => {
    const { sql, params } = query.toSQL();
    return (db.$client.prepare(`explain query plan ${sql}`).all(...params) as Array<{ detail: string }>)
      .map((step) => step.detail)
      .join(' | ');
  };

  it('servent la révocation des sessions d’un membre', () => {
    const db = openDb(':memory:');
    expect(plan(db, db.delete(sessions).where(eq(sessions.userId, 'a')))).toContain('sessions_user_id_idx');
  });

  it('servent la purge des sessions expirées', () => {
    const db = openDb(':memory:');
    expect(plan(db, db.delete(sessions).where(lte(sessions.expiresAt, new Date())))).toContain(
      'sessions_expires_at_idx',
    );
  });
});

describe('contrainte sur users.role', () => {
  it('accepte chaque rôle partagé et refuse un rôle inconnu', () => {
    const db = openDb(':memory:');
    for (const role of roles) expect(() => insertUser(db, role)).not.toThrow();
    expect(() => insertUser(db, 'superadmin')).toThrow(/CHECK constraint failed/);
    expect(() => db.$client.prepare("update users set role = 'root' where id = 'u-member'").run()).toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe('users.quota_override', () => {
  const quotas = '{"movies":{"limit":2,"days":7},"seasons":null}';

  it('refuse un JSON invalide à l’écriture', () => {
    const db = openDb(':memory:');
    expect(() => insertUser(db, 'member', '{pas du json')).toThrow(/CHECK constraint failed/);
    expect(() => insertUser(db, 'member', quotas)).not.toThrow();
  });

  it('est validé à la lecture : une valeur hors schéma ou illisible vaut null, journalisée, sans erreur', () => {
    const db = openDb(':memory:');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertUser(db, 'member', quotas);
    insertUser(db, 'manager', '{"movies":"beaucoup"}');
    expect(getUser(db, 'u-member')?.quotaOverride).toEqual({ movies: { limit: 2, days: 7 }, seasons: null });
    expect(log).not.toHaveBeenCalled();

    expect(getUser(db, 'u-manager')?.quotaOverride).toBeNull();
    expect(listUsers(db)).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(2);

    // Même un JSON invalide (contrainte contournée) ne fait pas échouer la lecture.
    db.$client.pragma('ignore_check_constraints = ON');
    insertUser(db, 'owner', '{pas du json');
    db.$client.pragma('ignore_check_constraints = OFF');
    expect(getUser(db, 'u-owner')?.quotaOverride).toBeNull();
  });
});

describe('users.last_login_at', () => {
  it('reste null pour un membre importé, jusqu’à sa première connexion', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-01-01T10:00:00Z');
    const identity = { id: 'a', name: 'A', avatar: null };
    expect(importFromEmby(db, identity, now).lastLoginAt).toBeNull();
    expect(importFromEmby(db, { ...identity, name: 'A2' }, now).lastLoginAt).toBeNull();
    expect(toMember(getUser(db, 'a') as User).lastLoginAt).toBeNull();

    expect(upsertFromEmby(db, { ...identity, isEmbyAdmin: false }, now).lastLoginAt).toEqual(now);
    expect(importFromEmby(db, identity).lastLoginAt).toEqual(now); // un import ne touche pas à la dernière connexion
    expect(toMember(getUser(db, 'a') as User).lastLoginAt).toBe(now.toISOString());
  });
});

describe('PRAGMA', () => {
  it('sont appliqués à l’ouverture de la base', () => {
    const { db } = openDataDir(tempDir());
    const pragma = (name: string) => db.$client.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('busy_timeout')).toBe(5000);
    expect(pragma('synchronous')).toBe(1); // NORMAL
    expect(pragma('journal_size_limit')).toBe(64 * 1024 * 1024);
    db.$client.close();
  });
});

describe('migration 0002 (durcissement)', () => {
  /** Dossier de migrations tronqué à `count` entrées : la base telle qu'elle était avant 0002. */
  const truncatedMigrations = (count: number) => {
    const dir = join(tempDir(), 'migrations');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    const journalFile = join(migrationsFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.slice(0, count);
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const { tag } of journal.entries) cpSync(join(migrationsFolder, `${tag}.sql`), join(dir, `${tag}.sql`));
    return dir;
  };

  it('conserve les membres existants et leur rôle', () => {
    const sqlite = new Database(join(tempDir(), 'avant.db'));
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(2) });
    sqlite.exec(`
      insert into users (id, name, avatar, role, quota_override, last_login_at) values
        ('a', 'Alice', 'http://emby/a.png', 'owner', '{"movies":{"limit":2,"days":7},"seasons":null}', 1700000000),
        ('b', 'Bob', null, 'auto_approve', null, 1700000100);
      insert into sessions (id, user_id, expires_at) values ('s1', 'a', 1900000000);
      insert into settings (key, value) values ('tmdb', '{}');
    `);

    migrate(drizzle({ client: sqlite }), { migrationsFolder });

    const rows = sqlite.prepare('select * from users order by id').all();
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'a',
        name: 'Alice',
        avatar: 'http://emby/a.png',
        role: 'owner',
        quota_override: '{"movies":{"limit":2,"days":7},"seasons":null}',
        last_login_at: 1700000000,
      }),
      expect.objectContaining({ id: 'b', name: 'Bob', avatar: null, role: 'auto_approve', last_login_at: 1700000100 }),
    ]);
    expect(sqlite.prepare('select count(*) as n from settings').get()).toEqual({ n: 1 });
    // Compromis accepté avant la production (voir le commentaire de la migration) : la recréation de `users`
    // supprime les sessions en cascade, les membres se reconnectent.
    expect(sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
    // Les contraintes sont bien posées sur la table renommée.
    expect(() => sqlite.prepare("insert into users (id, name, role) values ('c', 'C', 'root')").run()).toThrow(
      /CHECK constraint failed/,
    );
    sqlite.close();
  });
});
