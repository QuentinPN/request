import type { z } from 'zod';

/** Nature de l'échec ; l'interface s'appuie dessus (le message est déjà lisible, en français). */
export type IntegrationErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'not_found' | 'bad_response' | 'http';

/**
 * Seule erreur levée par les intégrations. `message` est affichable tel quel à l'utilisateur
 * et ne contient jamais de secret ; `url` est l'adresse appelée, secrets masqués.
 */
export class IntegrationError extends Error {
  readonly kind: IntegrationErrorKind;
  readonly service: string;
  readonly status?: number;
  readonly url?: string;

  constructor(
    kind: IntegrationErrorKind,
    service: string,
    message: string,
    details: { status?: number; url?: string } = {},
  ) {
    super(message);
    this.name = 'IntegrationError';
    this.kind = kind;
    this.service = service;
    if (details.status !== undefined) this.status = details.status;
    if (details.url !== undefined) this.url = details.url;
  }
}

const DEFAULT_MESSAGES: Record<IntegrationErrorKind, (service: string, status?: number) => string> = {
  unreachable: (s) => `${s} injoignable à cette adresse`,
  timeout: (s) => `${s} n'a pas répondu à temps`,
  unauthorized: (s) => `Clé d'API refusée par ${s}`,
  not_found: (s) => `Adresse ou ressource introuvable chez ${s}`,
  bad_response: (s) => `Réponse inattendue de ${s}`,
  http: (s, status) => `${s} a répondu par une erreur (${status})`,
};

type Query = Record<string, string | number | boolean | undefined>;

/** Options d'un appel ; `get/post/put/delete` d'un client en reprennent l'essentiel. */
export interface RequestOptions {
  query?: Query;
  headers?: Record<string, string>;
  /** Corps JSON (sérialisé et envoyé avec `content-type: application/json`). */
  body?: unknown;
  /** Délai par tentative, en ms (défaut 8000). */
  timeoutMs?: number;
  /** Nouvelles tentatives, GET uniquement, sur erreur réseau / 5xx / 429 (défaut 2). Un délai dépassé n'est pas retenté. */
  retries?: number;
  /** Attente avant la 1re nouvelle tentative, doublée ensuite (défaut 250 ms ; `Retry-After` prime, plafonné à 2 s). */
  retryDelayMs?: number;
  /** Remplace le message par défaut d'un type d'erreur, ex. `{ unauthorized: 'Identifiants refusés par Emby' }`. */
  messages?: Partial<Record<IntegrationErrorKind, string>>;
}

export interface HttpRequest<T> extends RequestOptions {
  /** Nom affiché dans les messages d'erreur : « Radarr », « Emby », « TMDB »… */
  service: string;
  baseUrl: string;
  /** Chemin relatif à `baseUrl` (un préfixe comme `/emby` dans `baseUrl` est conservé). */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Schéma Zod de la réponse JSON ; une réponse vide vaut `undefined`. */
  schema: z.ZodType<T>;
}

const SECRET_PARAM =
  /^(api[_-]?key|x-api-key|key|token|access[_-]?token|x-emby-token|secret|client[_-]?secret|password|passwd|pwd|pw|auth|authorization)$/i;
const MAX_RETRY_AFTER_MS = 2000;

/** Adresse sans identifiants ni valeur de paramètre sensible (`api_key`, `token`, `password`…), sûre pour un message ou un log. */
export function redactUrl(raw: string | URL): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.set(name, '***');
  return url.toString();
}

function buildUrl(baseUrl: string, path: string, query: Query = {}): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
  return url;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Retry-After` en secondes ou en date HTTP, plafonné. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Appel HTTP typé et validé, point d'entrée unique des intégrations. Renvoie la réponse validée par `schema`
 * ou lève une {@link IntegrationError}.
 */
export async function httpRequest<T>(req: HttpRequest<T>): Promise<T> {
  const { service, schema, messages } = req;
  const method = req.method ?? 'GET';
  const fail = (kind: IntegrationErrorKind, url?: URL, status?: number) =>
    new IntegrationError(kind, service, messages?.[kind] ?? DEFAULT_MESSAGES[kind](service, status), {
      ...(status !== undefined && { status }),
      ...(url && { url: redactUrl(url) }),
    });

  let url: URL;
  try {
    url = buildUrl(req.baseUrl, req.path, req.query);
  } catch {
    throw fail('unreachable');
  }

  const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  const attempts = method === 'GET' ? (req.retries ?? 2) + 1 : 1;
  const retryDelay = req.retryDelayMs ?? 250;

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(req.timeoutMs ?? 8000),
        ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
      });
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw fail('timeout', url);
      if (last) throw fail('unreachable', url);
      await sleep(retryDelay * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      let data: unknown;
      try {
        data = text.trim() === '' ? undefined : JSON.parse(text);
      } catch {
        throw fail('bad_response', url, res.status);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw fail('bad_response', url, res.status);
      return parsed.data;
    }
    if (res.status >= 300 && res.status < 400)
      throw new IntegrationError(
        'http',
        service,
        messages?.http ?? `${service} a répondu par une redirection ; vérifiez l'adresse (http/https)`,
        { status: res.status, url: redactUrl(url) },
      );
    if (res.status === 401 || res.status === 403) throw fail('unauthorized', url, res.status);
    if (res.status === 404) throw fail('not_found', url, res.status);
    if (last || (res.status < 500 && res.status !== 429)) throw fail('http', url, res.status);
    await sleep(retryAfterMs(res) ?? retryDelay * 2 ** (attempt - 1));
  }
}

const definedOnly = <O extends object>(options: O): O =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as O;

/** Valeurs communes à tous les appels d'un service (adresse, en-têtes d'authentification, paramètres fixes). */
export interface ClientConfig
  extends Pick<RequestOptions, 'headers' | 'query' | 'timeoutMs' | 'retries' | 'retryDelayMs' | 'messages'> {
  service: string;
  baseUrl: string;
}

/**
 * Client d'un service : fixe `service`, `baseUrl`, en-têtes et paramètres communs (ex. `X-Api-Key`).
 * `client.get('/api/v3/system/status', schema, { query })`, `client.post(path, schema, { body })`.
 */
export function createClient(config: ClientConfig) {
  const send = <T>(
    method: NonNullable<HttpRequest<T>['method']>,
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ) =>
    httpRequest({
      ...config,
      ...definedOnly(options),
      method,
      path,
      schema,
      headers: { ...config.headers, ...options.headers },
      query: { ...config.query, ...options.query },
      messages: { ...config.messages, ...options.messages },
    });
  return {
    get: <T>(path: string, schema: z.ZodType<T>, options?: RequestOptions) => send('GET', path, schema, options),
    post: <T>(path: string, schema: z.ZodType<T>, options?: RequestOptions) => send('POST', path, schema, options),
    put: <T>(path: string, schema: z.ZodType<T>, options?: RequestOptions) => send('PUT', path, schema, options),
    delete: <T>(path: string, schema: z.ZodType<T>, options?: RequestOptions) => send('DELETE', path, schema, options),
  };
}
