import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMAGE_CACHE_PATH, type ImageCacheStats } from '../../shared/cache.ts';
import {
  isAdjustableJob,
  JOBS_PATH,
  type JobInfo,
  jobIdSchema,
  jobIntervalInputSchema,
  jobPath,
  jobRunPath,
} from '../../shared/jobs.ts';
import { LOGS_PATH, type LogList, logsQuerySchema } from '../../shared/logs.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import type { LogBuffer } from '../lib/log-buffer.ts';
import { ownerOnly } from '../plugins/auth.ts';
import type { ImageCache } from '../services/images.ts';
import type { JobCenter } from '../services/job-center.ts';

const jobParamsSchema = z.object({ id: jobIdSchema });

/**
 * Tâches planifiées, cache d'images et journaux récents (propriétaire seulement). Les journaux ne contiennent jamais
 * de secret : le tampon les expurge avant de les garder (`lib/log-buffer.ts`).
 */
export function maintenanceRoutes(
  app: FastifyInstance,
  { jobs, images, logs }: { jobs: JobCenter; images: ImageCache; logs: LogBuffer },
) {
  app.get(JOBS_PATH, ownerOnly, async (): Promise<JobInfo[]> => jobs.list());

  // 202 : la tâche tourne en arrière-plan, son résultat arrive dans la liste (`job_runs`).
  app.post(jobRunPath(':id'), ownerOnly, async (req, reply): Promise<JobInfo> => {
    const { id } = parseRequest(jobParamsSchema, req.params);
    const started = jobs.run(id);
    reply.code(202);
    return started;
  });

  app.put(jobPath(':id'), ownerOnly, async (req): Promise<JobInfo> => {
    const { id } = parseRequest(jobParamsSchema, req.params);
    if (!isAdjustableJob(id)) throw new HttpError(400, 'La fréquence de cette tâche est fixe');
    const { intervalMinutes } = parseRequest(jobIntervalInputSchema(id), req.body);
    return jobs.setInterval(id, intervalMinutes);
  });

  app.get(IMAGE_CACHE_PATH, ownerOnly, async (): Promise<ImageCacheStats> => images.stats());

  app.delete(IMAGE_CACHE_PATH, ownerOnly, async (): Promise<ImageCacheStats> => {
    await images.clear();
    return images.stats();
  });

  app.get(LOGS_PATH, ownerOnly, async (req): Promise<LogList> => logs.list(parseRequest(logsQuerySchema, req.query)));
}
