import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { closedPortUrl, type FakeRoutes, startFakeServer, status } from './fake-server.ts';
import { loginAsOwner, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const serveImage: FakeRoutes[string] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG);
};

async function setup(routes: FakeRoutes = {}, imagesUrl?: string) {
  const upstream = await startFakeServer(routes);
  const dir = tempDir();
  const app = await buildApp({ data: openDataDir(dir), upstreams: { imagesUrl: imagesUrl ?? upstream.url } });
  cleanups.push(() => app.close(), upstream.close);
  const { headers } = await loginAsOwner(app);
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  return { get, upstream, dir };
}

describe('GET /api/images/:size/:file', () => {
  it('télécharge, met en cache sur disque et sert avec les bons en-têtes', async () => {
    const { get, upstream, dir } = await setup({ 'GET /w342/abc_1-2.png': serveImage });
    const res = await get('/api/images/w342/abc_1-2.png');

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=2592000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(readFileSync(join(dir, 'cache', 'images', 'w342', 'abc_1-2.png')).equals(PNG)).toBe(true);
    expect(upstream.requests).toHaveLength(1);
  });

  it('sert la 2e demande depuis le disque, sans rappeler TMDB', async () => {
    const { get, upstream } = await setup({ 'GET /w500/x.jpg': serveImage });
    await get('/api/images/w500/x.jpg');
    const again = await get('/api/images/w500/x.jpg');

    expect(again.statusCode).toBe(200);
    expect(again.headers['content-type']).toBe('image/jpeg');
    expect(upstream.requests).toHaveLength(1);
  });

  it('ne garde pas de fichier temporaire après écriture', async () => {
    const { get, dir } = await setup({ 'GET /w185/x.webp': serveImage });
    await get('/api/images/w185/x.webp');

    expect(readdirSync(join(dir, 'cache', 'images', 'w185'))).toEqual(['x.webp']);
  });

  it('partage un seul téléchargement entre demandes simultanées', async () => {
    const { get, upstream } = await setup({
      'GET /w780/slow.jpg': async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await serveImage(req, res);
      },
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () => get('/api/images/w780/slow.jpg')));

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(upstream.requests).toHaveLength(1);
  });

  it('sert un SVG sous une politique qui interdit les scripts', async () => {
    const { get } = await setup({ 'GET /original/logo.svg': serveImage });
    const res = await get('/api/images/original/logo.svg');

    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('relaie le 404 de TMDB, sans rien mettre en cache', async () => {
    const { get, dir } = await setup({ 'GET /w342/missing.jpg': status(404) });
    const res = await get('/api/images/w342/missing.jpg');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Image introuvable' });
    expect(existsSync(join(dir, 'cache', 'images', 'w342', 'missing.jpg'))).toBe(false);
  });

  it('renvoie 502 quand TMDB répond par une erreur, injoignable ou trop lent', async () => {
    const failing = await setup({ 'GET /w342/a.jpg': status(500) });
    const res = await failing.get('/api/images/w342/a.jpg');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Image TMDB indisponible (500)' });

    const down = await setup({}, await closedPortUrl());
    const unreachable = await down.get('/api/images/w342/a.jpg');
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.json()).toEqual({ error: 'Image TMDB injoignable' });
  });

  it('ne met pas en cache une réponse qui n’est pas une image (502)', async () => {
    const { get, dir } = await setup({
      'GET /w342/page.jpg': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      },
    });
    const res = await get('/api/images/w342/page.jpg');

    expect(res.statusCode).toBe(502);
    expect(existsSync(join(dir, 'cache', 'images', 'w342', 'page.jpg'))).toBe(false);
  });

  it.each([
    '/api/images/w999/a.jpg', // taille hors liste
    '/api/images/w342/a.gif', // extension hors liste
    '/api/images/w342/a', // sans extension
    '/api/images/w342/..%2F..%2Fsecret.key', // parcours encodé
    '/api/images/w342/%2E%2E%2Fsecret.jpg',
    '/api/images/w342/a%2Fb.jpg',
    '/api/images/w342/a..jpg',
    '/api/images/w342/a%5Cb.jpg', // antislash
    '/api/images/w342/.jpg',
    '/api/images/w342/%2e%2e%2Fsecret.jpg', // parcours encodé en minuscules
    '/api/images/w342/con.jpg', // noms réservés de Windows
    '/api/images/w342/NUL.png',
    '/api/images/w342/Com1.webp',
    '/api/images/w342/lpt9.svg',
  ])('%s → 400, TMDB jamais appelé', async (url) => {
    const { get, upstream, dir } = await setup();
    const res = await get(url);

    expect(res.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(0);
    expect(existsSync(join(dir, 'cache'))).toBe(false);
  });

  it('un chemin avec ../ brut ne correspond à aucune route', async () => {
    const { get, upstream } = await setup();
    const res = await get('/api/images/w342/../../secret.key');

    expect(res.statusCode).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });
});
