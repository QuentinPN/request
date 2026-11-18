import {
  type AdjustableJobId,
  boundsOf,
  isAdjustableJob,
  JOB,
  type JobId,
  type JobInfo,
  jobDefinitions,
  jobIds,
} from '../../shared/jobs.ts';
import type { Data } from '../db/index.ts';
import { HttpError } from '../lib/api-errors.ts';
import { MINUTE_MS } from '../lib/time.ts';
import type { Backups } from './backup.ts';
import { lastRun } from './jobs.ts';
import { getSetting, setSetting } from './settings.ts';
import type { ScanIntervals, Scheduler, SyncService } from './sync.ts';

/** Fréquence d'une tâche réglable, en minutes : celle du propriétaire, sinon le défaut. */
export function intervalMinutesOf(data: Pick<Data, 'db' | 'cryptoKey'>, id: AdjustableJobId): number {
  return getSetting(data.db, data.cryptoKey, 'jobs')?.intervalMinutes[id] ?? boundsOf(id).default;
}

/** Fréquences des balayages en millisecondes, relues à chaque appel (le propriétaire peut les changer à tout moment). */
export const scanIntervalsOf = (data: Pick<Data, 'db' | 'cryptoKey'>): ScanIntervals => ({
  lightMs: intervalMinutesOf(data, JOB.scanLight) * MINUTE_MS,
  fullMs: intervalMinutesOf(data, JOB.scanFull) * MINUTE_MS,
});

/**
 * Tâches planifiées vues du propriétaire : état et dernière exécution (`job_runs`), prochaine exécution, « Lancer
 * maintenant » et fréquence. `scheduler` et `backupTimer` sont absents tant que la planification est coupée (tests) :
 * aucune prochaine exécution, mais le lancement manuel et le réglage fonctionnent.
 */
export function createJobCenter(
  data: Data,
  deps: {
    sync: SyncService;
    backups: Backups;
    scheduler: Scheduler | null;
    backupTimer: { nextRunAt: () => number } | null;
  },
) {
  const { db } = data;
  const { sync, backups, scheduler, backupTimer } = deps;
  const inFlight = new Set<Promise<void>>();

  const launchers: Record<JobId, () => Promise<void> | null> = {
    [JOB.scanLight]: sync.launch[JOB.scanLight],
    [JOB.scanFull]: sync.launch[JOB.scanFull],
    [JOB.backup]: backups.launch,
  };

  const isEnabled = (id: JobId) => id !== JOB.backup || backups.enabled;

  function nextRunMs(id: JobId): number | null {
    if (!isEnabled(id)) return null;
    if (id === JOB.scanLight) return scheduler?.nextLightAt() ?? null;
    if (id === JOB.scanFull) return scheduler?.nextFullAt() ?? null;
    return backupTimer?.nextRunAt() ?? null;
  }

  function info(id: JobId): JobInfo {
    const { label, description } = jobDefinitions[id];
    const last = lastRun(db, id);
    const next = nextRunMs(id);
    return {
      id,
      label,
      description,
      intervalMinutes: isAdjustableJob(id) ? intervalMinutesOf(data, id) : null,
      bounds: isAdjustableJob(id) ? boundsOf(id) : null,
      enabled: isEnabled(id),
      running: last?.status === 'running',
      lastRun: last,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
    };
  }

  return {
    list: (): JobInfo[] => jobIds.map(info),
    info,
    /**
     * Lance la tâche sans attendre sa fin (409 si elle est déjà en cours ou coupée : jamais deux exécutions à la fois,
     * le verrou est celui de `job_runs`).
     */
    run(id: JobId): JobInfo {
      if (!isEnabled(id)) throw new HttpError(409, 'Cette tâche est désactivée');
      const running = launchers[id]();
      if (!running) throw new HttpError(409, 'Cette tâche est déjà en cours');
      inFlight.add(running);
      void running.finally(() => inFlight.delete(running));
      return info(id);
    },
    /** Enregistre la fréquence d'une tâche réglable et l'applique tout de suite, sans redémarrage. */
    setInterval(id: AdjustableJobId, minutes: number): JobInfo {
      const stored = getSetting(data.db, data.cryptoKey, 'jobs') ?? { intervalMinutes: {} };
      setSetting(data.db, data.cryptoKey, 'jobs', { intervalMinutes: { ...stored.intervalMinutes, [id]: minutes } });
      scheduler?.reschedule();
      return info(id);
    },
    /** Attend les lancements manuels en cours (avant de fermer la base). */
    async idle() {
      await Promise.all(inFlight);
    },
  };
}

export type JobCenter = ReturnType<typeof createJobCenter>;
