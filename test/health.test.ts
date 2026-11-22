import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { healthSchema } from '../src/shared/health.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();

describe('GET /api/health', () => {
  it('répond ok avec la version, conforme au schéma partagé', async () => {
    const app = await buildApp({ data: openDataDir(tempDir()) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(healthSchema.parse(res.json()).status).toBe('ok');
    await app.close();
  });

  it('répond 503 sans session quand la base ne répond plus', async () => {
    const data = openDataDir(tempDir());
    const app = await buildApp({ data });
    data.db.$client.close(true);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Base de données indisponible' });
    await app.close().catch(() => {});
  });
});
