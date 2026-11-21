import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** Corps JSON décodé, sinon texte brut ; `undefined` si vide. */
  body: unknown;
}

export type FakeHandler = (req: FakeRequest, res: ServerResponse) => void | Promise<void>;
/** Route : handler, ou valeur JSON renvoyée telle quelle avec un statut 200. */
export type FakeRoutes = Record<string, FakeHandler | Record<string, unknown> | unknown[]>;

const sendJson = (res: ServerResponse, code: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

/** Handler qui répond avec ce statut (et ce corps JSON, ces en-têtes). */
export const status =
  (code: number, body?: unknown, headers?: Record<string, string>): FakeHandler =>
  (_req, res) =>
    sendJson(res, code, body, headers);

/** Handler qui attend `ms` avant de répondre (simule un service lent, pour les délais d'expiration). */
export const delay =
  (ms: number, body: unknown = {}): FakeHandler =>
  async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (!res.destroyed) sendJson(res, 200, body);
  };

/** Handlers successifs (un par appel) ; le dernier se répète. */
export const sequence = (...handlers: FakeHandler[]): FakeHandler => {
  let calls = 0;
  return (req, res) => handlers[Math.min(calls++, handlers.length - 1)]?.(req, res);
};

async function record(req: IncomingMessage): Promise<FakeRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url ?? '/', 'http://fake');
  let body: unknown = raw === '' ? undefined : raw;
  try {
    if (raw !== '') body = JSON.parse(raw);
  } catch {
    // corps non JSON : on garde le texte brut
  }
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body,
  };
}

/**
 * Vrai serveur HTTP local (port libre) : `routes` associe `'METHOD /chemin'` à un handler ou une valeur JSON ;
 * route inconnue → 404. `requests` liste les appels reçus, dans l'ordre.
 */
export async function startFakeServer(routes: FakeRoutes = {}) {
  const requests: FakeRequest[] = [];
  const server = createServer(async (incoming, res) => {
    const req = await record(incoming);
    requests.push(req);
    const route = routes[`${req.method} ${req.path}`];
    try {
      if (typeof route === 'function') await (route as FakeHandler)(req, res);
      else if (route !== undefined) sendJson(res, 200, route);
      else sendJson(res, 404, { message: 'not found' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { message: 'handler error' });
      else res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { url, requests, close };
}

/**
 * Adresse où rien n'écoute : simule un service injoignable. Port 9 (discard) : les faux serveurs n'écoutent que sur des
 * ports éphémères (listen(0)), aucun ne le prend. Un port fraîchement libéré pouvait être repris par le faux serveur d'un
 * autre fichier de test lancé en parallèle, et la connexion aboutissait.
 */
export async function closedPortUrl(): Promise<string> {
  return 'http://127.0.0.1:9';
}
