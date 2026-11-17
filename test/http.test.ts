import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClient, httpRequest, IntegrationError, redactUrl } from '../src/server/integrations/http.ts';
import { closedPortUrl, delay, sequence, startFakeServer, status } from './fake-server.ts';

const statusSchema = z.object({ version: z.string() });
const closers: Array<() => Promise<void>> = [];
const serve = async (routes: Parameters<typeof startFakeServer>[0]) => {
  const server = await startFakeServer(routes);
  closers.push(server.close);
  return server;
};
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const STATUS = 'GET /api/v3/system/status';
const call = (baseUrl: string, options: Partial<Parameters<typeof httpRequest<{ version: string }>>[0]> = {}) =>
  httpRequest({
    service: 'Radarr',
    baseUrl,
    path: '/api/v3/system/status',
    schema: statusSchema,
    retryDelayMs: 1,
    ...options,
  });
const failure = async (promise: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await promise;
  } catch (error) {
    return error as IntegrationError;
  }
  throw new Error('aurait dû échouer');
};

describe('httpRequest', () => {
  it("renvoie la réponse validée, avec query, en-têtes et préfixe d'adresse", async () => {
    const server = await serve({ 'GET /emby/api/v3/system/status': { version: '5.0' } });
    const data = await call(`${server.url}/emby/`, {
      query: { page: 2, skip: undefined },
      headers: { 'x-api-key': 'k' },
    });
    expect(data).toEqual({ version: '5.0' });
    expect(server.requests[0]).toMatchObject({ query: { page: '2' }, headers: { 'x-api-key': 'k' } });
  });

  it('envoie un corps JSON en POST, sans nouvelle tentative sur erreur 5xx', async () => {
    const server = await serve({ 'POST /api/v3/movie': status(503) });
    const error = await failure(call(server.url, { method: 'POST', path: '/api/v3/movie', body: { title: 'Heat' } }));
    expect(error).toMatchObject({ kind: 'http', status: 503 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      body: { title: 'Heat' },
      headers: { 'content-type': 'application/json' },
    });
  });

  it('réponse hors schéma ou non JSON → bad_response', async () => {
    const server = await serve({ [STATUS]: { version: 5 }, 'GET /text': (_req, res) => void res.end('<html>') });
    expect(await failure(call(server.url))).toMatchObject({
      kind: 'bad_response',
      message: 'Réponse inattendue de Radarr',
    });
    expect(await failure(call(server.url, { path: '/text', service: 'TMDB' }))).toMatchObject({
      kind: 'bad_response',
      message: 'Réponse inattendue de TMDB',
    });
  });

  it.each([401, 403])('%i → unauthorized, sans nouvelle tentative', async (code) => {
    const server = await serve({ [STATUS]: status(code) });
    expect(await failure(call(server.url))).toMatchObject({
      kind: 'unauthorized',
      status: code,
      message: "Clé d'API refusée par Radarr",
    });
    expect(server.requests).toHaveLength(1);
  });

  it('404 → not_found ; message remplaçable', async () => {
    const server = await serve({});
    expect(await failure(call(server.url))).toMatchObject({ kind: 'not_found', status: 404 });
    expect(await failure(call(server.url, { messages: { not_found: 'Film inconnu' } }))).toHaveProperty(
      'message',
      'Film inconnu',
    );
  });

  it("GET : 5xx puis 429 sont retentés jusqu'au succès", async () => {
    const server = await serve({
      [STATUS]: sequence(status(503), status(429, {}, { 'retry-after': '0' }), status(200, { version: '1' })),
    });
    expect(await call(server.url)).toEqual({ version: '1' });
    expect(server.requests).toHaveLength(3);
  });

  it('Retry-After : secondes et date HTTP (plafonné)', async () => {
    for (const value of ['1', new Date(Date.now() + 3000).toUTCString()]) {
      const server = await serve({
        [STATUS]: sequence(status(429, {}, { 'retry-after': value }), status(200, { version: '1' })),
      });
      const start = Date.now();
      await call(server.url);
      expect(Date.now() - start).toBeGreaterThanOrEqual(900);
      expect(Date.now() - start).toBeLessThan(2900);
    }
  });

  it('redirection → http, sans suivre ni divulguer la clé', async () => {
    const target = await serve({ [STATUS]: { version: '1' } });
    const server = await serve({
      [STATUS]: status(302, undefined, { location: `${target.url}/api/v3/system/status` }),
    });
    const error = await failure(call(server.url, { headers: { 'x-api-key': 'SECRET' } }));
    expect(error).toMatchObject({ kind: 'http', status: 302 });
    expect(error.message).toContain('redirection');
    expect(target.requests).toHaveLength(0);
  });

  it('corps blanc → undefined', async () => {
    const server = await serve({ [STATUS]: (_req, res) => void res.writeHead(200).end('  \n') });
    expect(
      await httpRequest({
        service: 'Radarr',
        baseUrl: server.url,
        path: '/api/v3/system/status',
        schema: z.undefined(),
      }),
    ).toBeUndefined();
  });

  it('GET : abandonne après les nouvelles tentatives', async () => {
    const server = await serve({ [STATUS]: status(500) });
    expect(await failure(call(server.url, { retries: 1 }))).toMatchObject({ kind: 'http', status: 500 });
    expect(server.requests).toHaveLength(2);
  });

  it('délai dépassé → timeout', async () => {
    const server = await serve({ [STATUS]: delay(500) });
    expect(await failure(call(server.url, { timeoutMs: 50 }))).toMatchObject({
      kind: 'timeout',
      message: "Radarr n'a pas répondu à temps",
    });
  });

  it('port fermé → unreachable, après nouvelles tentatives', async () => {
    const error = await failure(call(await closedPortUrl()));
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ kind: 'unreachable', message: 'Radarr injoignable à cette adresse' });
  });

  it("ne divulgue aucun secret dans les messages ni dans l'adresse conservée", async () => {
    const server = await serve({ [STATUS]: status(401) });
    const error = await failure(
      call(server.url, { query: { api_key: 'SECRET1', token: 'SECRET2' }, headers: { 'x-api-key': 'SECRET3' } }),
    );
    expect(`${error.message} ${error.url}`).not.toMatch(/SECRET/);
    expect(error.url).toContain('api_key=***');
    const dead = await failure(call(await closedPortUrl(), { query: { apikey: 'SECRET4' } }));
    expect(`${dead.message} ${dead.url}`).not.toMatch(/SECRET/);
  });
});

describe('createClient', () => {
  it('applique en-têtes et paramètres communs à chaque appel', async () => {
    const server = await serve({ [STATUS]: { version: '5' } });
    const client = createClient({
      service: 'Radarr',
      baseUrl: server.url,
      headers: { 'x-api-key': 'k' },
      query: { lang: 'fr' },
    });
    await client.get('/api/v3/system/status', statusSchema, { query: { page: 1 } });
    expect(server.requests[0]).toMatchObject({ query: { lang: 'fr', page: '1' }, headers: { 'x-api-key': 'k' } });
  });
});

describe('createClient (undefined)', () => {
  it("un undefined explicite n'écrase pas la config", async () => {
    const server = await serve({ [STATUS]: status(500) });
    const client = createClient({ service: 'Radarr', baseUrl: server.url, retries: 0, retryDelayMs: 1 });
    await failure(client.get('/api/v3/system/status', statusSchema, { retries: undefined }));
    expect(server.requests).toHaveLength(1);
  });
});

describe('redactUrl', () => {
  it('ne masque pas les clés inoffensives', () => {
    expect(redactUrl('http://h/x?author=bob&token=t')).toBe('http://h/x?author=bob&token=***');
  });

  it('masque identifiants et paramètres sensibles', () => {
    expect(redactUrl('http://user:pw@host/x?api_key=abc&q=1')).toBe('http://host/x?api_key=***&q=1');
  });
});
