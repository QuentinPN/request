import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Health } from '../shared/health.ts';
import type { Data } from './db/index.ts';

declare module 'fastify' {
  interface FastifyInstance {
    data: Data;
  }
}

const root = resolve(import.meta.dirname, '../..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/** `/api`, `/api/...` et `/api?...` appartiennent à l'API, jamais à la SPA. */
export const isApiPath = (url: string) => /^\/api(?:[/?]|$)/.test(url);

/** Construit l'application sans écouter de port : réutilisée par le serveur, le dev Vite et les tests. */
export async function buildApp({ clientDir, data }: { clientDir?: string; data: Data }) {
  const app = Fastify({ logger: false });
  app.decorate('data', data);
  app.addHook('onClose', () => data.db.$client.close());

  app.get('/api/health', async (): Promise<Health> => ({ status: 'ok', version }));

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
