import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { type JobId, type JobRunStatus, type JobRunSummary, jobDefinitions } from '../../shared/jobs.ts';
import { changes, type Db } from '../db/index.ts';
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
  return changes(
    db
      .update(jobRuns)
      .set({ status: 'failed', finishedAt: new Date(), detail: 'Interrompue par un redémarrage du serveur' })
      .where(eq(jobRuns.status, 'running'))
      .run(),
  );
}

/** Écrit dans le journal de l'appli (`app.log`) l'issue d'une tâche. */
export type JobLog = Pick<FastifyBaseLogger, 'info' | 'error'>;

/**
 * Prend le verrou de `job` puis lance `work` sans l'attendre : `null` si une exécution est déjà en cours (rien n'est
 * fait), sinon la promesse de la fin de l'exécution. Son issue est enregistrée (`detail` : résumé, ou message
 * d'erreur) et journalisée sous `label` ; une erreur n'est jamais relancée (tâche planifiée), la promesse ne rejette pas.
 */
export function launchJob(db: Db, job: JobId, work: () => Promise<string>, log?: JobLog): Promise<void> | null {
  const id = startJob(db, job);
  if (id === null) return null;
  const label = jobDefinitions[job].label;
  return (async () => {
    try {
      const detail = await work();
      finishJob(db, id, 'success', detail);
      log?.info(`${label} terminé : ${detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishJob(db, id, 'failed', message);
      log?.error(`${label} en échec : ${message}`);
    }
  })();
}

/** Comme `launchJob`, en attendant la fin de l'exécution ; `false` si une exécution est déjà en cours. */
export async function runJob(db: Db, job: JobId, work: () => Promise<string>, log?: JobLog): Promise<boolean> {
  const running = launchJob(db, job, work, log);
  if (!running) return false;
  await running;
  return true;
}

/** Dernière exécution de `job` (la plus récemment démarrée, en cours comprise), `null` si aucune. */
export function lastRun(db: Db, job: JobId): JobRunSummary | null {
  const row = db
    .select()
    .from(jobRuns)
    .where(eq(jobRuns.job, job))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    detail: row.detail,
  };
}

/** Début de la dernière exécution de `job` terminée avec `status` (index `(job, started_at)` parcouru à rebours), `null` si aucune. */
function lastStartedAt(db: Db, job: string, status: JobRunStatus): Date | null {
  return (
    db
      .select({ startedAt: jobRuns.startedAt })
      .from(jobRuns)
      .where(and(eq(jobRuns.job, job), eq(jobRuns.status, status)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1)
      .get()?.startedAt ?? null
  );
}

export const lastSuccessAt = (db: Db, job: string) => lastStartedAt(db, job, 'success');
export const lastFailureAt = (db: Db, job: string) => lastStartedAt(db, job, 'failed');
