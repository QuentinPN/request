import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { openDataDir } from '../src/server/db/index.ts';
import { DAY_MS } from '../src/server/lib/time.ts';
import {
  backupDatabase,
  backupsDir,
  DEFAULT_BACKUP_KEEP,
  parseBackupKeep,
  startBackups,
} from '../src/server/services/backup.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();

function openWithRow() {
  const data = openDataDir(tempDir());
  const sqlite = data.db.$client;
  sqlite.exec("create table if not exists probe (v text); insert into probe values ('avant');");
  return { data, sqlite, dir: backupsDir(data.dir) };
}

describe('backupDatabase', () => {
  it('écrit une copie cohérente et lisible de la base', async () => {
    const { sqlite, dir } = openWithRow();
    const file = await backupDatabase(sqlite, dir, { now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });

    expect(file).toBe(join(dir, 'request-20260102-030405.db'));
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare('select v from probe').all()).toEqual([{ v: 'avant' }]);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    sqlite.close();
  });

  it('ne garde que les N copies les plus récentes, sans toucher aux autres fichiers', async () => {
    const { sqlite, dir } = openWithRow();
    for (let day = 1; day <= 4; day++)
      await backupDatabase(sqlite, dir, { keep: 2, now: () => Date.UTC(2026, 0, day, 12) });

    expect(readdirSync(dir).sort()).toEqual(['request-20260103-120000.db', 'request-20260104-120000.db']);
    sqlite.close();
  });

  it("n'efface jamais un fichier étranger du dossier", async () => {
    const { sqlite, dir } = openWithRow();
    await backupDatabase(sqlite, dir, { keep: 1, now: () => Date.UTC(2026, 0, 1) });
    sqlite.exec('create table other (x)');
    const foreign = join(dir, 'notes.txt');
    writeFileSync(foreign, 'à garder');
    await backupDatabase(sqlite, dir, { keep: 1, now: () => Date.UTC(2026, 0, 2) });

    expect(existsSync(foreign)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toHaveLength(1);
    sqlite.close();
  });
});

describe('parseBackupKeep', () => {
  it.each([
    [undefined, DEFAULT_BACKUP_KEEP],
    ['', DEFAULT_BACKUP_KEEP],
    ['abc', DEFAULT_BACKUP_KEEP],
    ['-1', DEFAULT_BACKUP_KEEP],
    ['2.5', DEFAULT_BACKUP_KEEP],
    ['0', 0],
    ['14', 14],
  ])('%s → %s', (env, expected) => {
    expect(parseBackupKeep(env)).toBe(expected);
  });
});

describe('startBackups', () => {
  it('ne planifie rien quand BACKUP_KEEP vaut 0 (arrêt immédiat, aucun dossier créé)', async () => {
    const { data, sqlite } = openWithRow();
    await startBackups(sqlite, data.dir, 0).stop();

    expect(existsSync(backupsDir(data.dir))).toBe(false);
    sqlite.close();
  });

  it('fait une sauvegarde au premier tour puis attend un jour', async () => {
    const { data, sqlite, dir } = openWithRow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      let now = Date.now(); // la date des fichiers vient du disque : pas d'horloge simulée
      const backups = startBackups(sqlite, data.dir, 3, () => now);
      await vi.advanceTimersByTimeAsync(61_000);
      await backups.stop();
      expect(readdirSync(dir)).toHaveLength(1);

      now += 3_600_000; // une heure plus tard : trop tôt
      const again = startBackups(sqlite, data.dir, 3, () => now);
      await vi.advanceTimersByTimeAsync(61_000);
      await again.stop();
      expect(readdirSync(dir)).toHaveLength(1);

      now += DAY_MS;
      const later = startBackups(sqlite, data.dir, 3, () => now);
      await vi.advanceTimersByTimeAsync(61_000);
      await later.stop();
      expect(readdirSync(dir)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      sqlite.close();
    }
  });
});
