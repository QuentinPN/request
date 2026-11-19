import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { API_FEATURES, API_VERSION, apiVersionSchema } from '../src/shared/api-version.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();

describe('GET /api/version', () => {
  it('répond sans session avec la version et les capacités, conformes au schéma partagé', async () => {
    const app = await buildApp({ data: openDataDir(tempDir()) });
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    expect(apiVersionSchema.parse(res.json())).toEqual({
      apiVersion: API_VERSION,
      features: [...API_FEATURES],
    });
    await app.close();
  });
});
