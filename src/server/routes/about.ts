import type { FastifyInstance } from 'fastify';
import { ABOUT_PATH, type About } from '../../shared/app-info.ts';
import { ownerOnly } from '../plugins/auth.ts';
import { computeAbout } from '../services/about.ts';

/** Réglages › À propos (propriétaire seulement) : version, environnement et compteurs, en lecture seule. */
export function aboutRoutes(app: FastifyInstance) {
  app.get(ABOUT_PATH, ownerOnly, async (): Promise<About> => computeAbout(app.data));
}
