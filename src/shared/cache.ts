import { settingsPathOf } from './settings-path.ts';

/** Cache disque des images (affiches, fonds) : nombre de fichiers et poids total. */
export interface ImageCacheStats {
  files: number;
  bytes: number;
  /** Taille au-delà de laquelle les images les moins récemment utilisées sont supprimées. */
  maxBytes: number;
}

export const IMAGE_CACHE_PATH = settingsPathOf('cache/images');
