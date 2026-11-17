import { CSRF_HEADERS } from '@shared/auth.ts';

/** Ce qui sait lire une réponse : un schéma Zod convient. Sans schéma, la réponse est prise au type annoncé. */
export type ResponseParser<T> = { parse: (data: unknown) => T };

/** Erreur renvoyée par l'API, avec son message lisible en français (`{ error }`). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 401 : pas (ou plus) de session. Au login, c'est un identifiant refusé : le message du serveur reste lisible. */
export class AuthRequiredError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = 'AuthRequiredError';
  }
}

async function request<T>(method: string, path: string, body: unknown, schema?: ResponseParser<T>): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') Object.assign(headers, CSRF_HEADERS);
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Le serveur ne répond pas. Vérifiez votre connexion.');
  }
  // 204 (déconnexion) : pas de corps à lire.
  const data: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : 'Erreur inattendue du serveur';
    throw res.status === 401 ? new AuthRequiredError(message) : new ApiError(res.status, message);
  }
  return schema ? schema.parse(data) : (data as T);
}

export const apiGet = <T>(path: string, schema?: ResponseParser<T>) => request('GET', path, undefined, schema);

export const apiSend = <T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  schema?: ResponseParser<T>,
) => request(method, path, body, schema);
