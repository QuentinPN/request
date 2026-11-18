import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PREFIX = 'v1';

/** Lit la clé de chiffrement, ou la crée au premier lancement (32 octets, lisible par le seul propriétaire). */
export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Clé de chiffrement invalide : ${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return key;
}

/** AES-256-GCM : `v1:iv:tag:texte`, chaque partie en base64url. */
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [PREFIX, iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join(':');
}

export function decrypt(key: Buffer, payload: string): string {
  const [prefix, iv, tag, data] = payload.split(':');
  if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error('Secret chiffré illisible');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Empreinte SHA-256 en hexadécimal : ce que la base garde d'un jeton ou d'une clé (jamais le secret lui-même). */
export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
