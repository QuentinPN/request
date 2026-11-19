import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';

/** État d'une exécution de tâche de fond (balayages, purges, sauvegardes), tel qu'enregistré dans `job_runs`. */
export const jobRunStatuses = ['running', 'success', 'failed'] as const;
export type JobRunStatus = (typeof jobRunStatuses)[number];

/** Noms des tâches planifiées dans `job_runs` (verrou : une seule exécution `running` par nom). */
export const JOB = { scanLight: 'scan:light', scanFull: 'scan:full', backup: 'backup' } as const;
export type JobId = (typeof JOB)[keyof typeof JOB];
export const jobIds = Object.values(JOB) as [JobId, ...JobId[]];
export const jobIdSchema = z.enum(jobIds);

/** Fréquence d'une tâche réglable, en minutes : bornes et défaut. */
export interface JobIntervalBounds {
  min: number;
  max: number;
  default: number;
}

/** Nom, rôle et fréquence réglable (`null` : fixe) de chaque tâche planifiée : la seule définition, client et serveur. */
export const jobDefinitions: Record<JobId, { label: string; description: string; interval: JobIntervalBounds | null }> =
  {
    [JOB.scanLight]: {
      label: 'Balayage léger',
      description: 'Derniers ajouts du serveur multimédia, titres en téléchargement et demandes envoyées',
      interval: { min: 5, max: 60, default: 10 },
    },
    [JOB.scanFull]: {
      label: 'Balayage complet',
      description: 'Recalcul de tous les titres suivis, purges des données anciennes et contrôle des membres',
      interval: { min: 6 * 60, max: 72 * 60, default: 24 * 60 },
    },
    [JOB.backup]: {
      label: 'Sauvegarde de la base',
      description: 'Copie cohérente de la base de données, une fois par jour',
      interval: null,
    },
  };

/** Tâches dont la fréquence se règle. */
export type AdjustableJobId = typeof JOB.scanLight | typeof JOB.scanFull;
export const isAdjustableJob = (id: JobId): id is AdjustableJobId => jobDefinitions[id].interval !== null;

/** Bornes d'une tâche réglable. */
export const boundsOf = (id: AdjustableJobId): JobIntervalBounds => jobDefinitions[id].interval as JobIntervalBounds;

/** Fréquence d'une tâche réglable, en minutes entières dans ses bornes. */
export const jobIntervalSchema = (id: AdjustableJobId) => z.number().int().min(boundsOf(id).min).max(boundsOf(id).max);

/** Corps de la modification de fréquence d'une tâche. */
export const jobIntervalInputSchema = (id: AdjustableJobId) => z.object({ intervalMinutes: jobIntervalSchema(id) });

/** Dernière exécution d'une tâche (`job_runs`). `detail` : résumé, ou message d'erreur. */
export interface JobRunSummary {
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Durée en millisecondes ; `null` tant que l'exécution est en cours. */
  durationMs: number | null;
  detail: string | null;
}

export interface JobInfo {
  id: JobId;
  label: string;
  description: string;
  /** Fréquence actuelle en minutes ; `null` pour une tâche à fréquence fixe. */
  intervalMinutes: number | null;
  bounds: JobIntervalBounds | null;
  /** `false` : tâche coupée (sauvegardes désactivées par `BACKUP_KEEP=0`). */
  enabled: boolean;
  running: boolean;
  lastRun: JobRunSummary | null;
  /** Prochaine exécution prévue ; `null` si la planification n'est pas active ou la tâche coupée. */
  nextRunAt: string | null;
}

export const JOBS_PATH = settingsPathOf('jobs');
export const jobPath = (id: JobId | ':id') => `${JOBS_PATH}/${id}`;
export const jobRunPath = (id: JobId | ':id') => `${jobPath(id)}/run`;
