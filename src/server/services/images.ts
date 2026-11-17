import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ImageSize } from '../../shared/media.ts';
import { IntegrationError } from '../integrations/http.ts';

const SERVICE = 'TMDB';
const DEFAULT_UPSTREAM = 'https://image.tmdb.org/t/p';
const DEFAULT_TIMEOUT_MS = 10_000;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Type MIME d'après l'extension d'un nom de fichier déjà validé (`imageFileSchema`). */
export const imageContentType = (file: string) =>
  CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

export interface ImageCacheOptions {
  /** Dossier de données : les images vont dans `<dir>/cache/images/<taille>/<fichier>`. */
  dir: string;
  /** Remplaçable pour les tests (défaut : le CDN d'images de TMDB). */
  upstreamUrl?: string;
  timeoutMs?: number;
}

/**
 * Cache disque des images TMDB. Les octets (binaires, pas du JSON) sont lus par un `fetch` direct plutôt que par
 * `httpRequest`, qui valide du JSON ; les échecs sont tout de même remontés en `IntegrationError`.
 * Deux demandes simultanées du même fichier partagent un seul téléchargement.
 */
export function createImageCache({
  dir,
  upstreamUrl = DEFAULT_UPSTREAM,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ImageCacheOptions) {
  const root = join(dir, 'cache', 'images');
  const downloads = new Map<string, Promise<Buffer | null>>();

  async function download(size: ImageSize, file: string, target: string): Promise<Buffer | null> {
    let body: Buffer;
    try {
      const res = await fetch(`${upstreamUrl.replace(/\/+$/, '')}/${size}/${file}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null;
      if (!res.ok)
        throw new IntegrationError('http', SERVICE, `Image TMDB indisponible (${res.status})`, { status: res.status });
      // Seule une image est mise en cache : une page HTML en 200 ne doit pas être servie comme image.
      if (!res.headers.get('content-type')?.startsWith('image/'))
        throw new IntegrationError('http', SERVICE, 'Image TMDB invalide');
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new IntegrationError(
        timedOut ? 'timeout' : 'unreachable',
        SERVICE,
        timedOut ? "TMDB n'a pas répondu à temps pour l'image" : 'Image TMDB injoignable',
      );
    }
    // Écriture atomique : un lecteur ne voit jamais un fichier à moitié écrit.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temp, body);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return body;
  }

  return {
    /** Octets de l'image (depuis le disque, sinon téléchargés puis mis en cache) ; `null` si TMDB ne la connaît pas. */
    async get(size: ImageSize, file: string): Promise<Buffer | null> {
      const target = join(root, size, file);
      try {
        return await readFile(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const key = `${size}/${file}`;
      let pending = downloads.get(key);
      if (!pending) {
        pending = download(size, file, target).finally(() => downloads.delete(key));
        downloads.set(key, pending);
      }
      return pending;
    },
  };
}

export type ImageCache = ReturnType<typeof createImageCache>;
