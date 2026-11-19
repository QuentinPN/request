import { IMAGE_CACHE_PATH, type ImageCacheStats } from '@shared/cache.ts';
import { type AdjustableJobId, JOBS_PATH, type JobId, type JobInfo, jobPath, jobRunPath } from '@shared/jobs.ts';
import { LOGS_PATH, type LogLevel, type LogList } from '@shared/logs.ts';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { apiGet, apiSend } from './http.ts';
import { formatDelay } from './stats.ts';

/** Délai entre deux relectures des tâches quand l'une tourne, et des journaux quand l'actualisation automatique est active. */
export const JOBS_POLL_MS = 3000;
export const LOGS_POLL_MS = 5000;

export const jobsQuery = queryOptions({
  queryKey: ['maintenance', 'jobs'],
  queryFn: ({ signal }) => apiGet<JobInfo[]>(JOBS_PATH, undefined, signal),
});

export const imageCacheQuery = queryOptions({
  queryKey: ['maintenance', 'image-cache'],
  queryFn: ({ signal }) => apiGet<ImageCacheStats>(IMAGE_CACHE_PATH, undefined, signal),
});

export interface LogFilters {
  level: LogLevel;
  q: string;
}

export const logsQuery = ({ level, q }: LogFilters) =>
  queryOptions({
    queryKey: ['maintenance', 'logs', level, q],
    queryFn: ({ signal }) => apiGet<LogList>(`${LOGS_PATH}?${new URLSearchParams({ level, q })}`, undefined, signal),
  });

export const runJob = (id: JobId) => apiSend<JobInfo>('POST', jobRunPath(id));
export const setJobInterval = (id: AdjustableJobId, intervalMinutes: number) =>
  apiSend<JobInfo>('PUT', jobPath(id), { intervalMinutes });
export const clearImageCache = () => apiSend<ImageCacheStats>('DELETE', IMAGE_CACHE_PATH);

export const invalidateMaintenance = (client: QueryClient) => client.invalidateQueries({ queryKey: ['maintenance'] });

/** Durée d'une exécution : « moins d’une seconde », « 12 s », puis minutes et heures. */
export function formatRunDuration(ms: number): string {
  if (ms < 1000) return 'moins d’une seconde';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return formatDelay(ms / 1000);
}

/** Fréquence : « toutes les 10 min », « toutes les 24 h », « toutes les 90 min ». */
export function formatInterval(minutes: number): string {
  return minutes % 60 === 0 && minutes >= 120 ? `toutes les ${minutes / 60} h` : `toutes les ${minutes} min`;
}
