import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

/** Version de l'appli : celle de `package.json`, copié dans l'image. */
export const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/** Commit de l'image (`GIT_SHA`, fixé au build par la CI) en 7 caractères ; `null` hors image publiée. */
export const parseCommit = (env: string | undefined): string | null => env?.trim().slice(0, 7) || null;
