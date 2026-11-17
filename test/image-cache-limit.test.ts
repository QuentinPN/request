import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageCache, parseImageCacheMaxBytes } from '../src/server/services/images.ts';
import { type FakeRoutes, startFakeServer } from './fake-server.ts';
import { trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MIB = 1024 * 1024;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const serveImage: FakeRoutes[string] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG);
};

const sizeDir = (dir: string) => join(dir, 'cache', 'images', 'w342');
const names = (dir: string) => readdirSync(sizeDir(dir)).sort();

/** Dépose un fichier de 10 octets dans le cache, modifié il y a `ageS` secondes. */
function seed(dir: string, name: string, ageS: number) {
  mkdirSync(sizeDir(dir), { recursive: true });
  const path = join(sizeDir(dir), name);
  writeFileSync(path, Buffer.alloc(10));
  const when = new Date(Date.now() - ageS * 1000);
  utimesSync(path, when, when);
}

describe('cache d’images borné', () => {
  it('supprime les fichiers les moins récents jusqu’à passer sous la limite', async () => {
    const dir = tempDir();
    seed(dir, 'old.jpg', 300);
    seed(dir, 'mid.jpg', 200);
    seed(dir, 'new.jpg', 100);
    await createImageCache({ dir, maxBytes: 20 }).prune();

    expect(names(dir)).toEqual(['mid.jpg', 'new.jpg']);
  });

  it('une lecture rafraîchit le fichier : le plus ancien, lu, survit', async () => {
    const dir = tempDir();
    seed(dir, 'old.jpg', 300);
    seed(dir, 'mid.jpg', 200);
    seed(dir, 'new.jpg', 100);
    const cache = createImageCache({ dir, maxBytes: 20 });
    await cache.get('w342', 'old.jpg');
    await cache.prune();

    expect(names(dir)).toEqual(['new.jpg', 'old.jpg']);
  });

  it('ignore les fichiers temporaires et ne touche pas un cache sous la limite', async () => {
    const dir = tempDir();
    seed(dir, 'a.jpg', 300);
    seed(dir, 'b.jpg.1234.tmp', 900);
    await createImageCache({ dir, maxBytes: 10 }).prune();

    expect(names(dir)).toEqual(['a.jpg', 'b.jpg.1234.tmp']);
  });

  it('nettoie après une écriture, en gardant le fichier qui vient d’être servi', async () => {
    const upstream = await startFakeServer({ 'GET /w342/fresh.png': serveImage });
    cleanups.push(upstream.close);
    const dir = tempDir();
    seed(dir, 'old.jpg', 300);
    const cache = createImageCache({ dir, upstreamUrl: upstream.url, maxBytes: PNG.length });

    expect((await cache.get('w342', 'fresh.png'))?.equals(PNG)).toBe(true);
    await vi.waitFor(() => expect(names(dir)).toEqual(['fresh.png']));
  });
});

describe('parseImageCacheMaxBytes', () => {
  it.each([
    [undefined, 500 * MIB],
    ['', 500 * MIB],
    ['abc', 500 * MIB],
    ['0', 500 * MIB],
    ['-5', 500 * MIB],
    ['100', 100 * MIB],
    ['0.5', MIB / 2],
  ])('%s → %s octets', (env, expected) => {
    expect(parseImageCacheMaxBytes(env)).toBe(expected);
  });
});
