import type { FastifyInstance } from 'fastify';
import { STATS_PATH, type Stats } from '../../shared/stats.ts';
import { requireCapability } from '../plugins/auth.ts';
import { computeStats } from '../services/stats.ts';

/** Statistiques de la page du même nom : gestionnaires et propriétaire (`canViewStats`), 403 sinon. */
export function statsRoutes(app: FastifyInstance) {
  app.get(
    STATS_PATH,
    { preHandler: requireCapability('canViewStats') },
    async (): Promise<Stats> => computeStats(app.data.db, app.tmdb),
  );
}
