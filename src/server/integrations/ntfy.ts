import { z } from 'zod';
import { httpRequest } from './http.ts';

export interface NtfyConfig {
  /** Serveur ntfy (`https://ntfy.sh` ou le sien), sans `/` final. */
  url: string;
  topic: string;
  /** Jeton d'accès (Bearer), sinon `username` et `password` (Basic), sinon sans authentification. */
  token: string | null;
  username: string | null;
  password: string | null;
}

export interface NtfyMessage {
  title: string;
  message: string;
}

const MESSAGES = {
  unauthorized: 'ntfy a refusé ces identifiants',
  not_found: 'Serveur ntfy introuvable à cette adresse',
} as const;

/** En-tête `Authorization` : jeton d'accès, sinon identifiant et mot de passe ; aucun sans l'un ni l'autre. */
function authorization({ token, username, password }: NtfyConfig): Record<string, string> {
  if (token) return { authorization: `Bearer ${token}` };
  if (username && password)
    return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  return {};
}

/** Publie un message sur le sujet (API JSON : POST à la racine du serveur) ; la réponse de ntfy n'a rien à valider. */
export function postNtfy(config: NtfyConfig, { title, message }: NtfyMessage): Promise<void> {
  return httpRequest({
    service: 'ntfy',
    baseUrl: config.url,
    path: '',
    method: 'POST',
    headers: authorization(config),
    body: { topic: config.topic, title, message },
    schema: z.unknown().transform(() => undefined),
    timeoutMs: 5000,
    messages: MESSAGES,
  });
}
