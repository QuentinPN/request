import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Health } from '../shared/health.ts';

const root = resolve(import.meta.dirname, '../..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/** Construit l'application sans écouter de port : réutilisée par le serveur, le dev Vite et les tests. */
export async function buildApp({ clientDir }: { clientDir?: string } = {}) {
  const app = Fastify({ logger: false });

  app.get('/api/health', async (): Promise<Health> => ({ status: 'ok', version }));

  if (clientDir && existsSync(clientDir)) {
    await app.register(fastifyStatic, { root: clientDir, wildcard: false });
    // SPA : toute route hors /api renvoie index.html.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Introuvable' }) : reply.sendFile('index.html'),
    );
  }
  return app;
}

export const clientDir = resolve(root, 'dist/client');
