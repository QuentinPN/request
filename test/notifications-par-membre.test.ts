import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/server/db/index.ts';
import {
  chosenTypes,
  notificationEnabled,
  notificationKinds,
  notificationTypes,
  receivableKinds,
} from '../src/shared/notifications.ts';
import { roles } from '../src/shared/roles.ts';
import { SLOW_TEST, trackTempDirs, truncatedMigrations } from './helpers.ts';

// Lot 8.10 : migration 0014 (types par membre, `auto_approved` dans `notifications.kind`, colonne de la demande
// automatique depuis Ma liste), sur une base 0013 (14 migrations) déjà peuplée. Le comportement (cloche, courriel, push, API)
// est testé dans `delivery.test.ts`.

const tempDir = trackTempDirs();

/** Base 0013 avec des notifications de chaque sorte (liées à une demande, à un signalement, ou à rien). */
function before0014() {
  const sqlite = new Database(join(tempDir(), 'avant.db'));
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle({ client: sqlite }), { migrationsFolder: truncatedMigrations(tempDir(), 14) });
  sqlite.exec(`
    insert into users (id, name, role, permissions) values
      ('a', 'Alice', 'owner', null), ('b', 'Bob', 'manager', '{"canManageIssues":false}'), ('c', 'Chloé', 'member', null);
    insert into sessions (id, user_id, expires_at) values ('s1', 'b', 1900000000);
    insert into media (id, type, tmdb_id, status, status_updated_at) values (1, 'movie', 10, 'available', 1700000000);
    insert into requests (id, media_id, user_id, status) values (1, 1, 'c', 'pending');
    insert into issues (id, media_id, user_id, type, message) values (1, 1, 'c', 'video', 'Saccadé');
    insert into notifications (id, user_id, kind, request_id, issue_id, detail, created_at, read_at) values
      (1, 'a', 'requested', 1, null, null, 1700000000, null),
      (2, 'c', 'declined', 1, null, 'Motif', 1700000100, 1700000200),
      (7, 'a', 'issue_created', null, 1, null, 1700000300, null),
      (9, 'b', 'failed', 1, null, 'Raison', 1700000400, null);
  `);
  return sqlite;
}

const rows = (sqlite: Database.Database, query: string) => sqlite.prepare(query).all();

describe('migration 0014 sur une base 0013 peuplée', () => {
  it('garde notifications, index, clés étrangères, membres et sessions ; ajoute les colonnes', SLOW_TEST, () => {
    const sqlite = before0014();
    const notificationRows = rows(sqlite, 'select * from notifications order by id');
    const indexes = (db: Database.Database) =>
      (db.pragma('index_list(notifications)') as Array<{ name: string; unique: number; partial: number }>)
        .map(({ name, unique, partial }) => ({ name, unique, partial }))
        .sort((x, y) => x.name.localeCompare(y.name));
    const keys = (db: Database.Database) =>
      (db.pragma('foreign_key_list(notifications)') as Array<Record<string, unknown>>)
        .map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete }))
        .sort((x, y) => String(x.from).localeCompare(String(y.from)));
    const indexesBefore = indexes(sqlite);
    const keysBefore = keys(sqlite);
    const sessionsBefore = rows(sqlite, 'select * from sessions');

    migrate(drizzle({ client: sqlite }), { migrationsFolder });

    // Notifications : mêmes lignes, mêmes ids.
    expect(rows(sqlite, 'select * from notifications order by id')).toEqual(notificationRows);
    // Les quatre index (dont trois partiels) et les trois clés étrangères sont recréés à l'identique.
    expect(indexes(sqlite)).toEqual(indexesBefore);
    expect(indexes(sqlite).map((i) => i.name)).toEqual([
      'notifications_issue_id_idx',
      'notifications_request_id_idx',
      'notifications_unread_idx',
      'notifications_user_id_created_at_idx',
    ]);
    expect(keys(sqlite)).toEqual(keysBefore);
    expect(keys(sqlite)).toEqual([
      { table: 'issues', from: 'issue_id', to: 'id', onDelete: 'SET NULL' },
      { table: 'requests', from: 'request_id', to: 'id', onDelete: 'SET NULL' },
      { table: 'users', from: 'user_id', to: 'id', onDelete: 'CASCADE' },
    ]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    // Index partiel des non lues toujours utilisé (la pastille de la cloche).
    const plan = rows(
      sqlite,
      "explain query plan select count(*) from notifications where user_id = 'a' and read_at is null",
    );
    expect(JSON.stringify(plan)).toContain('notifications_unread_idx');

    // Membres et sessions intacts (`users` n'est pas recréée : les sessions ne sont pas effacées en cascade).
    // Migration 0016 : les sessions existantes n'ont pas de nom d'appareil.
    expect(rows(sqlite, 'select * from sessions')).toEqual(
      sessionsBefore.map((s) => ({ ...(s as object), device_name: null })),
    );
    expect(
      rows(sqlite, 'select id, role, permissions, notification_types, watchlist_auto_request from users order by id'),
    ).toEqual([
      { id: 'a', role: 'owner', permissions: null, notification_types: null, watchlist_auto_request: 0 },
      {
        id: 'b',
        role: 'manager',
        permissions: '{"canManageIssues":false}',
        notification_types: null,
        watchlist_auto_request: 0,
      },
      { id: 'c', role: 'member', permissions: null, notification_types: null, watchlist_auto_request: 0 },
    ]);
    sqlite.close();
  });

  it(
    '`auto_approved` est accepté ; un type inconnu, refusé ; la cascade et le « SET NULL » fonctionnent encore',
    SLOW_TEST,
    () => {
      const sqlite = before0014();
      migrate(drizzle({ client: sqlite }), { migrationsFolder });
      const insert = (kind: string) =>
        sqlite.prepare("insert into notifications (user_id, kind, request_id) values ('b', ?, 1)").run(kind);
      for (const kind of notificationKinds) expect(() => insert(kind)).not.toThrow();
      expect(() => insert('inconnu')).toThrow(/CHECK constraint failed/);

      sqlite.exec('delete from requests where id = 1');
      expect(rows(sqlite, 'select count(*) as n from notifications where request_id is not null')).toEqual([{ n: 0 }]);
      sqlite.exec("delete from users where id = 'b'");
      expect(rows(sqlite, "select count(*) as n from notifications where user_id = 'b'")).toEqual([{ n: 0 }]);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      sqlite.close();
    },
  );

  it(
    '`notification_types` : un objet JSON ou rien ; `watchlist_auto_request` : un booléen, faux par défaut',
    SLOW_TEST,
    () => {
      const sqlite = before0014();
      migrate(drizzle({ client: sqlite }), { migrationsFolder });
      const setTypes = (value: string | null) =>
        sqlite.prepare("update users set notification_types = ? where id = 'c'").run(value);
      expect(() => setTypes('{"auto_approved":true}')).not.toThrow();
      expect(() => setTypes(null)).not.toThrow();
      for (const invalid of ['[1]', 'pas du json', '"texte"'])
        expect(() => setTypes(invalid)).toThrow(/CHECK constraint/);
      expect(() => sqlite.exec("update users set watchlist_auto_request = null where id = 'c'")).toThrow(/NOT NULL/);
      sqlite.close();
    },
  );
});

describe('types de notification : règles partagées', () => {
  it('chaque type a sa fiche ; seul `auto_approved` est désactivé d’office', () => {
    expect(Object.keys(notificationTypes).sort()).toEqual([...notificationKinds].sort());
    const off = notificationKinds.filter((kind) => !notificationEnabled(null, kind));
    expect(off).toEqual(['auto_approved']);
    expect(notificationEnabled({ auto_approved: true }, 'auto_approved')).toBe(true);
    expect(notificationEnabled({ approved: false }, 'approved')).toBe(false);
  });

  it('seul l’écart aux valeurs par défaut est gardé', () => {
    expect(chosenTypes({})).toBeNull();
    expect(chosenTypes({ approved: true, auto_approved: false })).toBeNull();
    expect(chosenTypes({ approved: false, auto_approved: true, declined: true })).toEqual({
      approved: false,
      auto_approved: true,
    });
  });

  it('les types de gestion ne sont proposés qu’à qui en a le droit', () => {
    const gestion = notificationKinds.filter((kind) => notificationTypes[kind].group === 'management');
    expect(gestion).toEqual(['requested', 'failed', 'auto_approved', 'issue_created']);
    for (const role of roles) {
      const offered = receivableKinds({ role, permissions: null });
      const manages = role === 'manager' || role === 'owner';
      expect(gestion.every((kind) => offered.includes(kind))).toBe(manages);
      expect(gestion.some((kind) => offered.includes(kind))).toBe(manages);
    }
    expect(receivableKinds({ role: 'member', permissions: { canManageIssues: true } })).toContain('issue_created');
    expect(receivableKinds({ role: 'member', permissions: { canManageIssues: true } })).not.toContain('requested');
  });
});
