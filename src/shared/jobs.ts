/** État d'une exécution de tâche de fond (balayages, purges, sauvegardes), tel qu'enregistré dans `job_runs`. */
export const jobRunStatuses = ['running', 'success', 'failed'] as const;
export type JobRunStatus = (typeof jobRunStatuses)[number];
