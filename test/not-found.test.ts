import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();

async function appWith(withClient: boolean) {
  const clientDir = join(tempDir(), 'client');
  mkdirSync(clientDir);
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>SPA</title>');
  return buildApp({ clientDir: withClient ? clientDir : undefined, data: openDataDir(tempDir()) });
}

describe.each([false, true])('chemins /api inconnus (client construit : %s)', (withClient) => {
  it.each(['/api/nope', '/api', '/api?x=1'])('%s renvoie 404 JSON', async (url) => {
    const app = await appWith(withClient);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ error: 'Introuvable' });
    await app.close();
  });
});

describe('hors /api', () => {
  it('sert index.html (SPA) quand le client est construit', async () => {
    const app = await appWith(true);
    const res = await app.inject({ method: 'GET', url: '/films' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>SPA</title>');
    await app.close();
  });

  it('renvoie 404 JSON sans client construit', async () => {
    const app = await appWith(false);
    const res = await app.inject({ method: 'GET', url: '/films' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Introuvable' });
    await app.close();
  });
});
