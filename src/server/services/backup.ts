import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { JOB } from '../../shared/jobs.ts';
import type { Db } from '../db/index.ts';
import { startPeriodic } from '../lib/periodic.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../lib/time.ts';
import { type JobLog, launchJob } from './jobs.ts';

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

/**
 * Sauvegarde quotidienne de la base, tâche `backup` de `job_runs` (verrou, dernier résultat). `keep` = 0 : désactivée.
 * `launch` fait une copie tout de suite (« Lancer maintenant »), `null` si une copie est déjà en cours ; `start`
 * planifie le contrôle horaire dans le processus du serveur (`schedule` seulement).
 */
export function createBackups(
  db: Db,
  dataDir: string,
  keep: number,
  { now = Date.now, log }: { now?: () => number; log?: JobLog } = {},
) {
  const dir = backupsDir(dataDir);
  /** Date de la copie la plus récente, `null` s'il n'y en a pas (ou pas encore de dossier). */
  const newestAt = (): number | null => {
    try {
      const newest = backupFiles(dir).sort().pop();
      return newest ? statSync(join(dir, newest)).mtimeMs : null;
    } catch {
      return null;
    }
  };
  /** Jamais avec `keep` = 0 : la purge des anciennes copies les supprimerait toutes. */
  const launch = () =>
    keep > 0
      ? launchJob(
          db,
          JOB.backup,
          async () => `Copie ${basename(await backupDatabase(db.$client, dir, { keep, now }))} écrite`,
          log,
        )
      : null;
  const start = () => {
    const periodic = startPeriodic(
      'Sauvegarde planifiée',
      () => {
        const newest = newestAt();
        return newest === null || now() - newest >= DAY_MS ? (launch() ?? undefined) : undefined;
      },
      { firstDelayMs: FIRST_CHECK_DELAY_MS, intervalMs: CHECK_INTERVAL_MS },
    );
    return {
      stop: periodic.stop,
      /** Prochaine copie : un jour après la dernière, au premier contrôle horaire suivant. */
      nextRunAt: () => Math.max(periodic.nextRunAt(), (newestAt() ?? 0) + DAY_MS),
    };
  };
  return { enabled: keep > 0, launch, start };
}

export type Backups = ReturnType<typeof createBackups>;
