import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Health } from '../shared/health.ts';
import type { Data } from './db/index.ts';
import type { TmdbClient } from './integrations/tmdb.ts';
import { apiErrorHandler } from './lib/api-errors.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { imageRoutes } from './routes/images.ts';
import { createImageCache } from './services/images.ts';
import { createTmdbProvider } from './services/tmdb.ts';

declare module 'fastify' {
  interface FastifyInstance {
    data: Data;
    /** Client TMDB d'après le réglage courant ; lève `NotConfiguredError` tant que TMDB n'est pas configuré. */
    tmdb: () => TmdbClient;
  }
}

/** Adresses amont remplaçables (tests) ; par défaut, les vrais services TMDB. */
export interface Upstreams {
  tmdbUrl?: string;
  imagesUrl?: string;
}

const root = resolve(import.meta.dirname, '../..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/** `/api`, `/api/...` et `/api?...` appartiennent à l'API, jamais à la SPA. */
export const isApiPath = (url: string) => /^\/api(?:[/?]|$)/.test(url);

/** Construit l'application sans écouter de port : réutilisée par le serveur, le dev Vite et les tests. */
export async function buildApp({
  clientDir,
  data,
  upstreams = {},
}: {
  clientDir?: string;
  data: Data;
  upstreams?: Upstreams;
}) {
  const app = Fastify({ logger: false });
  app.decorate('data', data);
  app.decorate('tmdb', createTmdbProvider(data, upstreams.tmdbUrl));
  app.addHook('onClose', () => data.db.$client.close());
  app.setErrorHandler(apiErrorHandler);

  app.get('/api/health', async (): Promise<Health> => ({ status: 'ok', version }));
  await app.register(catalogueRoutes);
  await app.register(
    imageRoutes(createImageCache({ dir: data.dir, ...(upstreams.imagesUrl && { upstreamUrl: upstreams.imagesUrl }) })),
  );

  const hasClient = clientDir !== undefined && existsSync(clientDir);
  if (hasClient) await app.register(fastifyStatic, { root: clientDir, wildcard: false });
  // /api inconnu : 404 JSON. Hors /api : index.html (SPA) si le client est construit, sinon 404 JSON.
  app.setNotFoundHandler((req, reply) =>
    hasClient && !isApiPath(req.url) ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Introuvable' }),
  );
  return app;
}

export const clientDir = resolve(root, 'dist/client');
export const dataDir = resolve(process.env.DATA_DIR ?? resolve(root, 'data'));
