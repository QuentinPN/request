import { and, eq } from 'drizzle-orm';
import type { JobRunStatus } from '../../shared/jobs.ts';
import type { Db } from '../db/index.ts';
import { jobRuns } from '../db/schema.ts';

/**
 * Démarre une exécution de `job` : `null` si une exécution est déjà en cours (verrou : index unique partiel
 * `job_runs_running`, l'insertion ne crée rien en cas de conflit). Sinon, l'id de l'exécution à terminer.
 * `ON CONFLICT DO NOTHING` sans cible : ce verrou est la seule contrainte d'unicité que l'insertion peut violer
 * (et Drizzle place mal le `WHERE` d'une cible d'index partiel).
 */
export function startJob(db: Db, job: string): number | null {
  const row = db
    .insert(jobRuns)
    .values({ job, status: 'running' })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id })
    .get();
  return row?.id ?? null;
}

/** Termine une exécution en cours (une exécution déjà terminée n'est pas modifiée). */
export function finishJob(db: Db, id: number, status: Exclude<JobRunStatus, 'running'>, detail?: string): void {
  db.update(jobRuns)
    .set({ status, finishedAt: new Date(), detail: detail ?? null })
    .where(and(eq(jobRuns.id, id), eq(jobRuns.status, 'running')))
    .run();
}

/** Au démarrage du serveur : une exécution encore `running` a été interrompue (arrêt, plantage) et ne finira jamais. */
export function failOrphanJobs(db: Db): number {
  return db
    .update(jobRuns)
    .set({ status: 'failed', finishedAt: new Date(), detail: 'Interrompue par un redémarrage du serveur' })
    .where(eq(jobRuns.status, 'running'))
    .run().changes;
}
