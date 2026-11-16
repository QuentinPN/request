import { defineConfig, devices } from '@playwright/test';

// Les tests e2e tournent contre le build de production servi par Fastify, comme sur le mini-PC.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'off' },
  projects: [
    { name: 'ordinateur', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: { command: 'node src/server/index.ts', url: 'http://localhost:3100/api/health', env: { PORT: '3100' } },
});
