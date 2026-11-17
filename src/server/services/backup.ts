import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.ts';

/** Copies conservées par défaut (`BACKUP_KEEP`) ; 0 désactive la sauvegarde quotidienne. */
export const DEFAULT_BACKUP_KEEP = 7;
/** Une sauvegarde automatique est faite quand la dernière date de plus d'un jour ; l'état est relu toutes les heures. */
const CHECK_INTERVAL_MS = HOUR_MS;
const FIRST_CHECK_DELAY_MS = MINUTE_MS;

/** `request-20260102-030405.db` (UTC) : l'ordre alphabétique est l'ordre chronologique. */
const BACKUP_FILE = /^request-\d{8}-\d{6}\.db$/;

export const backupsDir = (dataDir: string) => join(dataDir, 'backups');

/** `BACKUP_KEEP` : nombre entier ≥ 0, sinon le défaut. */
export function parseBackupKeep(env: string | undefined): number {
  const keep = Number(env);
  return env !== undefined && env.trim() !== '' && Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_BACKUP_KEEP;
}

const backupFiles = (dir: string) => readdirSync(dir).filter((name) => BACKUP_FILE.test(name));

/**
 * Sauvegarde en ligne cohérente (API de sauvegarde de SQLite : l'appli peut continuer d'écrire) dans `dir`, puis ne
 * garde que les `keep` copies les plus récentes. Écrite sous un nom temporaire puis renommée : une copie interrompue ne
 * ressemble jamais à une sauvegarde valide. Renvoie le chemin de la copie.
 */
export async function backupDatabase(
  sqlite: Database.Database,
  dir: string,
  { keep = DEFAULT_BACKUP_KEEP, now = Date.now }: { keep?: number; now?: () => number } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = join(dir, `request-${stamp}.db`);
  const temp = `${target}.tmp`;
  try {
    await sqlite.backup(temp);
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  for (const name of backupFiles(dir).sort().reverse().slice(keep)) rmSync(join(dir, name), { force: true });
  return target;
}

/** Sauvegardes quotidiennes dans le processus du serveur (`schedule` seulement) ; `keep` = 0 : rien n'est planifié. */
export function startBackups(sqlite: Database.Database, dataDir: string, keep: number, now: () => number = Date.now) {
  const dir = backupsDir(dataDir);
  const due = () => {
    try {
      const newest = backupFiles(dir).sort().pop();
      return !newest || now() - statSync(join(dir, newest)).mtimeMs >= DAY_MS;
    } catch {
      return true; // dossier pas encore créé
    }
  };
  let current: Promise<unknown> | null = null;
  const run = () => {
    if (current || !due()) return;
    current = backupDatabase(sqlite, dir, { keep, now })
      .catch((error: unknown) => console.error('Sauvegarde planifiée', error))
      .finally(() => {
        current = null;
      });
  };
  if (keep === 0) return { stop: async () => {} };
  const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
  };
}
