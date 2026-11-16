import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { healthSchema } from '../src/shared/health.ts';

describe('GET /api/health', () => {
  it('répond ok avec la version, conforme au schéma partagé', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(healthSchema.parse(res.json()).status).toBe('ok');
    await app.close();
  });
});
