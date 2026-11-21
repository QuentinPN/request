// Sauvegarde en ligne de la base SQLite dans <DATA_DIR>/backups, sans arrêter l'appli : `bun run backup`, ou dans le
// conteneur `docker compose exec request node scripts/backup.ts`. Variables : DATA_DIR, BACKUP_KEEP.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { dataDir } from '../src/server/app.ts';
import { backupDatabase, backupsDir, parseBackupKeep } from '../src/server/services/backup.ts';

const sqlite = new Database(join(dataDir, 'request.db'), { fileMustExist: true });
try {
  const keep = Math.max(1, parseBackupKeep(process.env.BACKUP_KEEP));
  console.log(`Sauvegarde : ${await backupDatabase(sqlite, backupsDir(dataDir), { keep })}`);
} finally {
  sqlite.close();
}
