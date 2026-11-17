/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { buildApp, dataDir, isApiPath } from './src/server/app.ts';
import { openDataDir } from './src/server/db/index.ts';

const root = import.meta.dirname;

// En dev, l'API Fastify tourne dans le même processus que Vite : une seule commande, un seul port.
function api(): Plugin {
  return {
    name: 'request-api',
    async configureServer(server) {
      const app = await buildApp({ data: openDataDir(dataDir) });
      await app.ready();
      server.middlewares.use((req, res, next) => (req.url && isApiPath(req.url) ? app.routing(req, res) : next()));
    },
  };
}

export default defineConfig({
  root: resolve(root, 'src/client'),
  publicDir: resolve(root, 'public'),
  plugins: [react(), tailwindcss(), api()],
  resolve: { alias: { '@': resolve(root, 'src/client'), '@shared': resolve(root, 'src/shared') } },
  server: { port: 3000, strictPort: true },
  build: { outDir: resolve(root, 'dist/client'), emptyOutDir: true },
  test: { root, include: ['test/**/*.test.ts'] },
});
