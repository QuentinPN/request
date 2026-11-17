import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadOrCreateKey } from '../crypto.ts';
import * as schema from './schema.ts';

export const migrationsFolder = resolve(import.meta.dirname, 'migrations');

/** Ouvre la base (`:memory:` pour les tests) et applique les migrations en attente. */
export function openDb(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof openDb>;

/** Dossier de données (volume /data en production) : base SQLite, clé de chiffrement des secrets et caches. */
export function openDataDir(dir: string) {
  return { dir, db: openDb(join(dir, 'request.db')), cryptoKey: loadOrCreateKey(join(dir, 'secret.key')) };
}

export type Data = ReturnType<typeof openDataDir>;
