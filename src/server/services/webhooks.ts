import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Data } from '../db/index.ts';
import { getSetting, setSetting } from './settings.ts';

/** Nouveau jeton aléatoire (256 bits), chiffré en base comme les autres secrets ; l'ancien cesse aussitôt de valoir. */
export function regenerateWebhookToken({ db, cryptoKey }: Data): string {
  return setSetting(db, cryptoKey, 'webhooks', { token: randomBytes(32).toString('base64url') }).token;
}

/** Jeton des webhooks, créé à la première lecture par le propriétaire. */
export function webhookToken(data: Data): string {
  return getSetting(data.db, data.cryptoKey, 'webhooks')?.token ?? regenerateWebhookToken(data);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Jeton reçu valide ? Comparaison en temps constant (empreintes de même longueur) ; aucun jeton enregistré (jamais
 * affiché au propriétaire) → toujours refusé.
 */
export function isValidWebhookToken({ db, cryptoKey }: Data, received: string | undefined): boolean {
  const stored = getSetting(db, cryptoKey, 'webhooks')?.token;
  if (!stored || !received) return false;
  return timingSafeEqual(digest(received), digest(stored));
}
