import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { jobRuns, settings } from '../src/server/db/schema.ts';
import { createLogBuffer, redactRequestUrl, scrubText, scrubValue } from '../src/server/lib/log-buffer.ts';
import { SESSION_COOKIE } from '../src/server/plugins/auth.ts';
import { createApiKey } from '../src/server/services/api-keys.ts';
import { startJob } from '../src/server/services/jobs.ts';
import { webhookToken } from '../src/server/services/webhooks.ts';
import { CSRF_HEADERS } from '../src/shared/auth.ts';
import { IMAGE_CACHE_PATH, type ImageCacheStats } from '../src/shared/cache.ts';
import { JOB, JOBS_PATH, type JobId, type JobInfo, jobPath, jobRunPath } from '../src/shared/jobs.ts';
import { LOGS_PATH, type LogList } from '../src/shared/logs.ts';
import { roles } from '../src/shared/roles.ts';
import { WEBHOOK_TOKEN_HEADER } from '../src/shared/webhooks.ts';
import { loginAs, loginAsOwner, trackApps, trackTempDirs } from './helpers.ts';

const newApp = trackApps();
const tempDir = trackTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
});

const jobsOf = async (app: FastifyInstance, headers: Record<string, string>) =>
  (await app.inject({ method: 'GET', url: JOBS_PATH, headers })).json<JobInfo[]>();

/** Attend la fin de la dernière exécution de `id` (la tâche tourne en arrière-plan après le 202). */
const finished = (app: FastifyInstance, headers: Record<string, string>, id: JobId) =>
  vi.waitFor(async () => {
    const job = (await jobsOf(app, headers)).find((j) => j.id === id);
    expect(job?.running).toBe(false);
    expect(job?.lastRun).not.toBeNull();
    return job as JobInfo;
  });

const logsOf = async (app: FastifyInstance, headers: Record<string, string>, query = '') =>
  (await app.inject({ method: 'GET', url: `${LOGS_PATH}${query}`, headers })).json<LogList>();

describe('accès', () => {
  const routes = [
    ['GET', JOBS_PATH],
    ['POST', jobRunPath(JOB.scanLight)],
    ['PUT', jobPath(JOB.scanLight)],
    ['GET', IMAGE_CACHE_PATH],
    ['DELETE', IMAGE_CACHE_PATH],
    ['GET', LOGS_PATH],
  ] as const;

  it.each(routes)('%s %s : 401 sans session', async (method, url) => {
    const app = await newApp();
    expect((await app.inject({ method, url, headers: CSRF_HEADERS })).statusCode).toBe(401);
  });

  it.each(roles.filter((role) => role !== 'owner'))('rôle %s (gestionnaire compris) : 403 partout', async (role) => {
    const app = await newApp();
    const { headers } = await loginAs(app, role);
    for (const [method, url] of routes)
      expect((await app.inject({ method, url, headers, payload: { intervalMinutes: 15 } })).statusCode, url).toBe(403);
    expect(app.data.db.select().from(jobRuns).all()).toEqual([]);
  });

  it('une clé d’API de propriétaire agit comme lui : lecture des journaux permise', async () => {
    const app = await newApp();
    const { user } = await loginAsOwner(app);
    const { secret } = createApiKey(app.data.db, user, 'Script');
    const res = await app.inject({ method: 'GET', url: LOGS_PATH, headers: { 'x-api-key': secret } });
    expect(res.statusCode).toBe(200);
  });
});

describe('liste des tâches', () => {
  it('les trois tâches avec leur nom, leur fréquence par défaut et leurs bornes ; rien n’a tourné', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const jobs = await jobsOf(app, headers);

    expect(jobs.map((j) => j.id)).toEqual([JOB.scanLight, JOB.scanFull, JOB.backup]);
    expect(jobs[0]).toMatchObject({
      label: 'Balayage léger',
      intervalMinutes: 10,
      bounds: { min: 5, max: 60, default: 10 },
      enabled: true,
      running: false,
      lastRun: null,
      nextRunAt: null, // planification coupée dans les tests
    });
    expect(jobs[1]).toMatchObject({
      label: 'Balayage complet',
      intervalMinutes: 1440,
      bounds: { min: 360, max: 4320 },
    });
    expect(jobs[2]).toMatchObject({ label: 'Sauvegarde de la base', intervalMinutes: null, bounds: null });
  });

  it('avec la planification active : prochaine exécution de chaque tâche', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const app = await buildApp({ data: openDataDir(tempDir()), schedule: true });
    try {
      const { headers } = await loginAsOwner(app);
      const before = Date.now();
      const jobs = await jobsOf(app, headers);
      for (const job of jobs) {
        expect(job.nextRunAt, job.id).not.toBeNull();
        expect(new Date(job.nextRunAt as string).getTime(), job.id).toBeGreaterThanOrEqual(before);
      }
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });
});

describe('« Lancer maintenant »', () => {
  it('202 tout de suite, puis le résultat (durée, détail) dans la liste et une ligne dans le journal', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const res = await app.inject({ method: 'POST', url: jobRunPath(JOB.scanLight), headers });

    expect(res.statusCode).toBe(202);
    expect(res.json<JobInfo>().id).toBe(JOB.scanLight);
    const job = await finished(app, headers, JOB.scanLight);
    expect(job.lastRun).toMatchObject({ status: 'success', detail: '0 titres recalculés' });
    expect(job.lastRun?.durationMs).toBeGreaterThanOrEqual(0);
    expect(app.data.db.select().from(jobRuns).all()).toHaveLength(1);
    const { entries } = await logsOf(app, headers);
    expect(entries.some((e) => e.level === 'info' && e.message.startsWith('Balayage léger terminé'))).toBe(true);
  });

  it('refusé (409) quand la tâche est déjà en cours : aucune seconde exécution', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    expect(startJob(app.data.db, JOB.scanLight)).not.toBeNull();

    const res = await app.inject({ method: 'POST', url: jobRunPath(JOB.scanLight), headers });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Cette tâche est déjà en cours' });
    expect(app.data.db.select().from(jobRuns).all()).toHaveLength(1);
    expect((await jobsOf(app, headers))[0]).toMatchObject({ running: true });
    // Les autres tâches restent lançables.
    expect((await app.inject({ method: 'POST', url: jobRunPath(JOB.scanFull), headers })).statusCode).toBe(202);
    await finished(app, headers, JOB.scanFull);
  });

  it('la sauvegarde se lance à la demande et écrit une copie', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    expect((await app.inject({ method: 'POST', url: jobRunPath(JOB.backup), headers })).statusCode).toBe(202);
    const job = await finished(app, headers, JOB.backup);

    expect(job.lastRun).toMatchObject({ status: 'success', detail: expect.stringContaining('Copie request-') });
    expect(existsSync(join(app.data.dir, 'backups'))).toBe(true);
  });

  it('sauvegardes désactivées (BACKUP_KEEP=0) : tâche coupée, lancement refusé', async () => {
    vi.stubEnv('BACKUP_KEEP', '0');
    const app = await newApp();
    const { headers } = await loginAsOwner(app);

    expect((await jobsOf(app, headers))[2]).toMatchObject({ enabled: false, nextRunAt: null });
    const res = await app.inject({ method: 'POST', url: jobRunPath(JOB.backup), headers });
    expect(res.statusCode).toBe(409);
    expect(existsSync(join(app.data.dir, 'backups'))).toBe(false);
  });

  it('tâche inconnue : 400', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    expect((await app.inject({ method: 'POST', url: jobRunPath('nope' as JobId), headers })).statusCode).toBe(400);
  });
});

describe('fréquence', () => {
  const put = (app: FastifyInstance, headers: Record<string, string>, id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: jobPath(id as JobId), headers, payload: payload as object });

  it('enregistrée dans les réglages (JSON, sans migration) et relue par la liste', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const res = await put(app, headers, JOB.scanLight, { intervalMinutes: 15 });

    expect(res.statusCode).toBe(200);
    expect(res.json<JobInfo>()).toMatchObject({ id: JOB.scanLight, intervalMinutes: 15 });
    await put(app, headers, JOB.scanFull, { intervalMinutes: 720 });
    const jobs = await jobsOf(app, headers);
    expect(jobs.map((j) => j.intervalMinutes)).toEqual([15, 720, null]);
    const [row] = app.data.db.select().from(settings).all();
    expect(row?.key).toBe('jobs');
    expect(JSON.parse(row?.value ?? '')).toEqual({ intervalMinutes: { 'scan:light': 15, 'scan:full': 720 } });
  });

  it.each([
    [JOB.scanLight, 5, 60],
    [JOB.scanFull, 360, 4320],
  ] as const)('%s : bornes %i à %i minutes incluses, le reste est refusé', async (id, min, max) => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    for (const ok of [min, max]) expect((await put(app, headers, id, { intervalMinutes: ok })).statusCode).toBe(200);
    for (const bad of [min - 1, max + 1, 0, -10, 7.5, '10', null, Number.NaN])
      expect((await put(app, headers, id, { intervalMinutes: bad })).statusCode, String(bad)).toBe(400);
    expect((await put(app, headers, id, {})).statusCode).toBe(400);
    expect((await jobsOf(app, headers)).find((j) => j.id === id)?.intervalMinutes).toBe(max);
  });

  it('la sauvegarde et une tâche inconnue n’ont pas de fréquence réglable', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    expect((await put(app, headers, JOB.backup, { intervalMinutes: 60 })).statusCode).toBe(400);
    expect((await put(app, headers, 'nope', { intervalMinutes: 60 })).statusCode).toBe(400);
  });
});

describe('cache d’images', () => {
  const cacheDir = (app: FastifyInstance) => join(app.data.dir, 'cache', 'images');

  it('nombre de fichiers et poids total, puis vidage ; les téléchargements en cours (.tmp) sont laissés', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    const empty = await app.inject({ method: 'GET', url: IMAGE_CACHE_PATH, headers });
    expect(empty.json<ImageCacheStats>()).toEqual({ files: 0, bytes: 0, maxBytes: 500 * 1024 * 1024 });

    mkdirSync(join(cacheDir(app), 'w342'), { recursive: true });
    mkdirSync(join(cacheDir(app), 'original'), { recursive: true });
    writeFileSync(join(cacheDir(app), 'w342', 'a.jpg'), Buffer.alloc(1000));
    writeFileSync(join(cacheDir(app), 'original', 'b.jpg'), Buffer.alloc(2500));
    writeFileSync(join(cacheDir(app), 'w342', 'c.jpg.tmp'), Buffer.alloc(99));
    const full = await app.inject({ method: 'GET', url: IMAGE_CACHE_PATH, headers });
    expect(full.json<ImageCacheStats>()).toMatchObject({ files: 2, bytes: 3500 });

    const cleared = await app.inject({ method: 'DELETE', url: IMAGE_CACHE_PATH, headers });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<ImageCacheStats>()).toMatchObject({ files: 0, bytes: 0 });
    expect(existsSync(join(cacheDir(app), 'w342', 'a.jpg'))).toBe(false);
    expect(existsSync(join(cacheDir(app), 'w342', 'c.jpg.tmp'))).toBe(true);
  });
});

describe('journaux', () => {
  it('niveau minimal, recherche (message et contexte, sans casse), plus récent d’abord, limite', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    app.log.info('démarrage tranquille');
    app.log.warn({ titre: 'Matrix' }, 'avertissement un');
    app.log.error('panne de Radarr');
    app.log.warn('avertissement deux');

    const all = await logsOf(app, headers);
    expect(all.entries.map((e) => e.message)).toEqual([
      'avertissement deux',
      'panne de Radarr',
      'avertissement un',
      'démarrage tranquille',
    ]);
    expect(all.matching).toBe(4);
    expect(all.entries.map((e) => e.level)).toEqual(['warn', 'error', 'warn', 'info']);
    expect((await logsOf(app, headers, '?level=warn')).entries.map((e) => e.message)).toEqual([
      'avertissement deux',
      'panne de Radarr',
      'avertissement un',
    ]);
    expect((await logsOf(app, headers, '?level=error')).entries.map((e) => e.message)).toEqual(['panne de Radarr']);
    expect((await logsOf(app, headers, '?q=RADARR')).entries).toHaveLength(1);
    expect((await logsOf(app, headers, '?q=matrix')).entries.map((e) => e.message)).toEqual(['avertissement un']);
    const limited = await logsOf(app, headers, '?limit=2');
    expect(limited.entries.map((e) => e.message)).toEqual(['avertissement deux', 'panne de Radarr']);
    expect(limited.matching).toBe(4);
  });

  it.each(['?level=trace', '?limit=0', '?limit=501', '?limit=abc', `?q=${'x'.repeat(101)}`])(
    'filtre invalide %s : 400',
    async (query) => {
      const app = await newApp();
      const { headers } = await loginAsOwner(app);
      expect((await app.inject({ method: 'GET', url: `${LOGS_PATH}${query}`, headers })).statusCode).toBe(400);
    },
  );

  it('les réponses refusées ou en échec sont journalisées ; les lectures ordinaires et les 404 non', async () => {
    const app = await newApp();
    const { headers } = await loginAsOwner(app);
    await app.inject({ method: 'GET', url: '/api/introuvable', headers });
    await app.inject({ method: 'GET', url: JOBS_PATH, headers });
    await app.inject({ method: 'PUT', url: jobPath(JOB.scanLight), headers, payload: { intervalMinutes: 1 } });

    const { entries } = await logsOf(app, headers);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'warn', message: `PUT ${jobPath(JOB.scanLight)} : 400` });
  });

  it('le tampon recopie ses lignes expurgées vers la sortie, jamais la ligne brute', () => {
    const lines: string[] = [];
    const buffer = createLogBuffer(3, (line) => lines.push(line));
    buffer.write(JSON.stringify({ level: 50, time: 0, msg: 'échec', url: '/hook?token=abc123' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ERROR échec');
    expect(lines[0]).not.toContain('abc123');
  });

  it('le tampon garde les dernières entrées seulement', () => {
    const buffer = createLogBuffer(3);
    for (const n of [1, 2, 3, 4, 5]) buffer.write(JSON.stringify({ level: 30, time: n, msg: `ligne ${n}` }));
    buffer.write('pas du JSON');
    const { entries, matching } = buffer.list({ level: 'debug', q: '', limit: 10 });
    expect(entries.map((e) => e.message)).toEqual(['ligne 5', 'ligne 4', 'ligne 3']);
    expect(matching).toBe(3);
  });
});

describe('secrets : jamais dans les journaux envoyés au navigateur', () => {
  it('jeton de webhook (adresse et en-tête), clé d’API et cookie de session : entrées présentes, valeurs masquées', async () => {
    const app = await newApp();
    const owner = await loginAsOwner(app);
    const token = webhookToken(app.data);
    const cookie = owner.headers.cookie as string;
    const cookieValue = cookie.split('=').slice(1).join('=');
    const { secret: apiKey } = createApiKey(app.data.db, owner.user, 'Script');

    // 1. Vrai jeton dans l'adresse d'un webhook, corps illisible : 400 journalisé avec l'adresse de la requête.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/webhooks/radarr?token=${token}&server=1`,
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);
    // 2. Faux jeton dans l'adresse et dans l'en-tête : 401 journalisé.
    await app.inject({ method: 'POST', url: '/api/webhooks/sonarr?token=jeton-inconnu-123', payload: {} });
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/sonarr',
      headers: { [WEBHOOK_TOKEN_HEADER]: token, 'content-type': 'application/json' },
      payload: '{',
    });
    // 3. Clé d'API et cookie de session sur des requêtes en échec (corps invalide).
    await app.inject({
      method: 'PUT',
      url: jobPath(JOB.scanLight),
      headers: { 'x-api-key': apiKey },
      payload: { intervalMinutes: 1 },
    });
    await app.inject({
      method: 'PUT',
      url: jobPath(JOB.scanLight),
      headers: owner.headers,
      payload: { intervalMinutes: 1 },
    });
    // 4. Ce que le code pourrait journaliser par erreur : en-têtes complets, texte libre, erreur.
    app.log.warn(
      {
        headers: { ...owner.headers, 'x-api-key': apiKey, 'x-webhook-token': token, authorization: `Bearer ${apiKey}` },
      },
      'en-têtes reçus',
    );
    app.log.error(`échec de https://radarr.local/api/v3/movie?apikey=${apiKey}&page=1`);
    app.log.error(new Error(`Cookie: ${cookie}; X-Api-Key: ${apiKey}`));
    app.log.error(`refusé avec Bearer ${apiKey}`);
    app.log.warn(
      { req: { method: 'GET', url: `/x?token=${token}`, headers: { cookie } } },
      'requête journalisée à la main',
    );

    const res = await app.inject({ method: 'GET', url: `${LOGS_PATH}?limit=500`, headers: owner.headers });
    const list = res.json<LogList>();
    const text = res.body;

    // Présence : chaque cas a bien produit une entrée, valeur du secret masquée.
    const messages = list.entries.map((e) => e.message);
    expect(messages).toContain('POST /api/webhooks/radarr : 400');
    expect(messages).toContain('POST /api/webhooks/sonarr : 401');
    expect(messages).toContain('PUT /api/settings/jobs/scan:light : 400');
    expect(messages).toContain('en-têtes reçus');
    const radarr = list.entries.find((e) => e.message === 'POST /api/webhooks/radarr : 400');
    expect(radarr?.context).toContain('/api/webhooks/radarr?token=***&server=1');
    expect(list.entries.find((e) => e.message === 'en-têtes reçus')?.context).toContain('***');
    expect(text).toContain('apikey=***');
    expect(text).toContain('Bearer ***');
    // Absence : ni jeton, ni clé, ni cookie (valeur signée ou brute), ni faux jeton.
    for (const secret of [token, apiKey, cookie, cookieValue, 'jeton-inconnu-123'])
      expect(text, secret).not.toContain(secret);
    expect(text).not.toContain(`${SESSION_COOKIE}=`);
  });
});

describe('expurgation', () => {
  it.each([
    ['/api/webhooks/radarr?token=abc123&server=2', '/api/webhooks/radarr?token=***&server=2'],
    ['/x?api_key=zzz&apikey=yyy&X-Plex-Token=t', '/x?api_key=***&apikey=***&X-Plex-Token=***'],
    ['/rien?page=2', '/rien?page=2'],
  ])('adresse %s', (raw, expected) => {
    expect(decodeURIComponent(redactRequestUrl(raw))).toBe(expected);
  });

  it.each([
    ['token=abc&x=1', 'token=***&x=1'],
    ['X-Api-Key: ur_secret', 'X-Api-Key: ***'],
    ['cookie: a=b; request_session=s.signature', 'cookie: ***; request_session=***'],
    ['Authorization: Bearer abc.def', 'Authorization: ***'],
    ['{"password":"hunter2","user":"a"}', '{"password":"***","user":"a"}'],
    ['monkey=1 et tokenizer ok', 'monkey=1 et tokenizer ok'],
  ])('texte %s', (text, expected) => {
    expect(scrubText(text)).toBe(expected);
  });

  it('valeurs imbriquées : clé secrète masquée à toute profondeur, le reste conservé', () => {
    expect(scrubValue({ a: { cookie: 'x', 'X-Api-Key': 'y', ok: 'token=z', list: [{ token: 't' }] }, n: 3 })).toEqual({
      a: { cookie: '***', 'X-Api-Key': '***', ok: 'token=***', list: [{ token: '***' }] },
      n: 3,
    });
  });
});
