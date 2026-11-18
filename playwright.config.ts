import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '3100';

// Les tests e2e tournent contre le build de production servi par Fastify, comme sur le mini-PC.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // Les runners GitHub ont 4 cœurs ; par défaut, Playwright n'en prendrait que la moitié.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Service worker bloqué : les requêtes qu'il verrait échapperaient aux faux serveurs (`page.route`). Le push du
  // navigateur est simulé au besoin (e2e/canaux-mocks.ts).
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off', serviceWorkers: 'block' },
  projects: [
    { name: 'ordinateur', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: 'node src/server/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT, DATA_DIR: join(tmpdir(), 'request-e2e') },
  },
});
