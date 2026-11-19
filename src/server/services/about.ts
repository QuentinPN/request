import { statSync } from 'node:fs';
import { join } from 'node:path';
import { count } from 'drizzle-orm';
import type { About } from '../../shared/app-info.ts';
import { emptyRequestCounts } from '../../shared/status.ts';
import { type Data, DB_FILE_NAME } from '../db/index.ts';
import { media, requests, users } from '../db/schema.ts';
import { parseCommit, version } from '../lib/build-info.ts';

/** Taille d'un fichier, 0 s'il n'existe pas (le journal -wal disparaît après un checkpoint). */
const sizeOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** Version, environnement et compteurs de Réglages › À propos. */
export function computeAbout({ db, dir }: Data): About {
  const file = join(dir, DB_FILE_NAME);
  const byStatus = emptyRequestCounts();
  for (const { status, n } of db
    .select({ status: requests.status, n: count() })
    .from(requests)
    .groupBy(requests.status)
    .all())
    byStatus[status] = n;
  const total = (table: typeof users | typeof media) => db.select({ n: count() }).from(table).get()?.n ?? 0;
  return {
    version,
    commit: parseCommit(process.env.GIT_SHA),
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dataDir: dir,
    databaseBytes: sizeOf(file) + sizeOf(`${file}-wal`),
    counts: {
      members: total(users),
      media: total(media),
      requests: Object.values(byStatus).reduce((a, b) => a + b, 0),
      requestsByStatus: byStatus,
    },
  };
}
