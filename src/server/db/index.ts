import { type Changes, Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { loadOrCreateKey } from '../crypto.ts';
import * as schema from './schema.ts';

export const migrationsFolder = resolve(import.meta.dirname, 'migrations');

/** Taille maximale du fichier -wal conservé après un checkpoint (64 Mio). */
const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

/** Ouvre la base (`:memory:` pour les tests) et applique les migrations en attente. */
export function openDb(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA foreign_keys = ON');
  sqlite.run('PRAGMA busy_timeout = 5000');
  // WAL + NORMAL : pas de fsync à chaque commit (au pire les dernières écritures sont perdues sur coupure, jamais la cohérence).
  sqlite.run('PRAGMA synchronous = NORMAL');
  sqlite.run(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  const db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof openDb>;

/** Lignes touchées par un `.run()` de Drizzle : bun:sqlite les renvoie, mais le pilote bun-sqlite de Drizzle le type `void`. */
export const changes = (result: unknown): number => (result as Changes).changes;

/** Fichier de la base SQLite dans le dossier de données. */
export const DB_FILE_NAME = 'request.db';

/** Dossier de données (volume /data en production) : base SQLite, clé de chiffrement des secrets et caches. */
export function openDataDir(dir: string) {
  return { dir, db: openDb(join(dir, DB_FILE_NAME)), cryptoKey: loadOrCreateKey(join(dir, 'secret.key')) };
}

export type Data = ReturnType<typeof openDataDir>;
