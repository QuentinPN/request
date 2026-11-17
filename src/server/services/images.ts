import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ImageSize } from '../../shared/media.ts';
import { IntegrationError } from '../integrations/http.ts';
import { MINUTE_MS } from '../lib/time.ts';

const SERVICE = 'TMDB';
const DEFAULT_UPSTREAM = 'https://image.tmdb.org/t/p';
const DEFAULT_TIMEOUT_MS = 10_000;
const MIB = 1024 * 1024;
/** Taille maximale du cache disque, en Mio (`IMAGE_CACHE_MAX_MB`). */
export const DEFAULT_IMAGE_CACHE_MAX_MB = 500;
/** Au plus un nettoyage du cache par minute : une page d'affiches écrit des dizaines de fichiers d'un coup. */
const PRUNE_INTERVAL_MS = MINUTE_MS;

/** `IMAGE_CACHE_MAX_MB` : nombre > 0 (décimal accepté), sinon le défaut ; renvoyé en octets. */
export function parseImageCacheMaxBytes(env: string | undefined): number {
  const mb = Number(env);
  const valid = env !== undefined && env.trim() !== '' && Number.isFinite(mb) && mb > 0;
  return (valid ? mb : DEFAULT_IMAGE_CACHE_MAX_MB) * MIB;
}

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
  /** Taille maximale du cache disque en octets (défaut : 500 Mio). */
  maxBytes?: number;
  /** Délai minimal entre deux nettoyages du cache (défaut : 1 minute). */
  pruneIntervalMs?: number;
}

/**
 * Cache disque des images TMDB. Les octets (binaires, pas du JSON) sont lus par un `fetch` direct plutôt que par
 * `httpRequest`, qui valide du JSON ; les échecs sont tout de même remontés en `IntegrationError`.
 * Deux demandes simultanées du même fichier partagent un seul téléchargement.
 * Le cache est borné à `maxBytes` : chaque lecture rafraîchit la date de modification du fichier, et après une
 * écriture (au plus une fois par `pruneIntervalMs`) les fichiers les moins récemment utilisés sont supprimés.
 */
export function createImageCache({
  dir,
  upstreamUrl = DEFAULT_UPSTREAM,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_IMAGE_CACHE_MAX_MB * MIB,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
}: ImageCacheOptions) {
  const root = join(dir, 'cache', 'images');
  const downloads = new Map<string, Promise<Buffer | null>>();
  let lastPrune = Number.NEGATIVE_INFINITY;
  let pruning: Promise<void> | null = null;

  /** Supprime les images les moins récemment utilisées jusqu'à passer sous `maxBytes` (fichiers temporaires ignorés). */
  async function prune(): Promise<void> {
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const size of await readdir(root).catch(() => [])) {
      for (const name of await readdir(join(root, size)).catch(() => [])) {
        if (name.endsWith('.tmp')) continue;
        const path = join(root, size, name);
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }

  function prunePeriodically() {
    const now = Date.now();
    if (pruning || now - lastPrune < pruneIntervalMs) return;
    lastPrune = now;
    pruning = prune()
      .catch((error: unknown) => console.error("Nettoyage du cache d'images", error))
      .finally(() => {
        pruning = null;
      });
  }

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
    prunePeriodically();
    return body;
  }

  return {
    /** Octets de l'image (depuis le disque, sinon téléchargés puis mis en cache) ; `null` si TMDB ne la connaît pas. */
    async get(size: ImageSize, file: string): Promise<Buffer | null> {
      const target = join(root, size, file);
      try {
        const body = await readFile(target);
        // Lu à l'instant : ce fichier passe en dernier dans l'ordre d'éviction.
        const now = new Date();
        await utimes(target, now, now).catch(() => {});
        return body;
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
    prune,
  };
}

export type ImageCache = ReturnType<typeof createImageCache>;
