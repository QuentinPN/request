import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { media } from '../src/server/db/schema.ts';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import {
  type AgentKey,
  agentKeys,
  agentSettingsPath,
  agentTestPath,
  NTFY_DEFAULT_URL,
  type OutgoingWebhookPayload,
} from '../src/shared/agents.ts';
import type { IssueDetail } from '../src/shared/issues.ts';
import { agentEventKinds, defaultAgentEventKinds } from '../src/shared/notifications.ts';
import type { RequestDetail } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import type { SettingInput } from '../src/shared/settings.ts';
import { status } from './fake-server.ts';
import { addArrServer, loginAs, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const NTFY_TOKEN = 'tk_jeton-ntfy-secret';
const NTFY_PASSWORD = 'mot-de-passe-ntfy';
const BOT_TOKEN = '123456:jeton-du-bot-secret';
const AUTHORIZATION = 'Bearer jeton-webhook-secret';
const HOOK_PATH = '/hooks/abc';

/** Configuration de chaque agent, sur les faux serveurs (`urls`), avec ses secrets. */
const configs = (urls: Record<'ntfy' | 'webhook', string>) =>
  ({
    ntfy: { enabled: true, url: urls.ntfy, topic: 'demandes', token: NTFY_TOKEN },
    telegram: { enabled: true, botToken: BOT_TOKEN, chatId: '-100123', threadId: 7, silent: true },
    outgoingWebhook: { enabled: true, url: `${urls.webhook}${HOOK_PATH}`, authorization: AUTHORIZATION },
  }) satisfies Partial<{ [K in AgentKey]: SettingInput<K> }>;

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** Appli branchée sur de faux TMDB, Radarr, ntfy, Telegram et webhook ; `enabled` : les agents déjà enregistrés. */
async function setup(options: { enabled?: readonly ('ntfy' | 'telegram' | 'outgoingWebhook')[]; reply?: number } = {}) {
  const tmdb = await startServer({ 'GET /movie/603': matrix });
  const radarr = await startServer({
    'GET /api/v3/movie': [],
    'GET /api/v3/queue': { totalRecords: 0, records: [] },
    'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
    'POST /api/v3/movie': status(201, { id: 42, hasFile: false, monitored: true }),
  });
  const reply = status(options.reply ?? 200, {});
  const ntfy = await startServer({ 'POST /': reply });
  const telegram = await startServer({
    [`POST /bot${BOT_TOKEN}/sendMessage`]: status(options.reply ?? 200, { ok: true }),
  });
  const webhook = await startServer({ [`POST ${HOOK_PATH}`]: reply });
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
  addArrServer({ db, cryptoKey }, { type: 'radarr', url: radarr.url, rootFolderPath: '/films' });
  const saved = configs({ ntfy: ntfy.url, webhook: webhook.url });
  for (const key of options.enabled ?? []) setSetting(db, cryptoKey, key, saved[key]);
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url, telegramUrl: telegram.url } });
  cleanups.push(() => app.close());

  const as = async (role: Role, id?: string) => {
    const { user, headers } = await loginAs(app, role, id);
    return {
      user,
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload?: object) =>
        app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
      put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers, payload }),
    };
  };
  const received = (server: { requests: Array<{ path: string; headers: object; body: unknown }> }) =>
    server.requests.map((r) => ({ path: r.path, headers: r.headers, body: r.body }) as Received);
  /** Appels reçus par chaque faux service, une fois les envois planifiés terminés. */
  const sent = async () => {
    await app.afterCommit.idle();
    return { ntfy: received(ntfy), telegram: received(telegram), webhook: received(webhook) };
  };
  return { app, data, saved, ntfy, telegram, webhook, tmdb, as, sent };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Actor = Awaited<ReturnType<Setup['as']>>;
const requestMovie = async (actor: Actor) =>
  (await actor.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

describe('distribution aux agents', () => {
  it('une demande à approuver : un message pour chaque agent actif, dans son format', async () => {
    const { as, sent, saved } = await setup({ enabled: ['ntfy', 'telegram', 'outgoingWebhook'] });
    const member = await as('member');
    await as('manager');
    await as('owner');
    const request = await requestMovie(member);

    const { ntfy, telegram, webhook } = await sent();
    // Un seul message par agent, pas un par gestionnaire.
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0]).toMatchObject({
      path: '/',
      headers: { authorization: `Bearer ${NTFY_TOKEN}` },
      body: {
        topic: 'demandes',
        title: 'Nouvelle demande à approuver',
        message: `Matrix (1999)\nDemandé par ${member.user.name}`,
      },
    });
    expect(telegram).toHaveLength(1);
    expect(telegram[0]?.body).toEqual({
      chat_id: '-100123',
      text: `Nouvelle demande à approuver\nMatrix (1999)\nDemandé par ${member.user.name}`,
      disable_notification: true,
      message_thread_id: 7,
    });
    expect(webhook).toHaveLength(1);
    expect(webhook[0]?.headers.authorization).toBe(AUTHORIZATION);
    expect(webhook[0]?.headers['content-type']).toBe('application/json');
    expect(webhook[0]?.body).toEqual({
      type: 'requested',
      title: 'Nouvelle demande à approuver',
      message: `Matrix (1999)\nDemandé par ${member.user.name}`,
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      request: { id: request.id, status: 'pending' },
      user: { name: member.user.name },
      issue: null,
    } satisfies OutgoingWebhookPayload);
    expect(saved.ntfy.token).toBe(NTFY_TOKEN);
  });

  it('refus : le motif est dans le message ; basic auth ntfy quand il n’y a pas de jeton', async () => {
    const { as, sent, data, ntfy } = await setup({ enabled: ['outgoingWebhook'] });
    setSetting(data.db, data.cryptoKey, 'ntfy', {
      enabled: true,
      url: ntfy.url,
      topic: 'demandes',
      username: 'alice',
      password: NTFY_PASSWORD,
    });
    const request = await requestMovie(await as('member'));
    await (await as('owner')).post(`/api/requests/${request.id}/decline`, { reason: 'Déjà en VO' });

    const result = await sent();
    const declined = result.webhook.find((r) => r.body.type === 'declined');
    expect(declined?.body).toMatchObject({
      title: 'Demande refusée',
      message: expect.stringContaining('Motif : Déjà en VO'),
      request: { id: request.id, status: 'declined' },
    });
    const basic = `Basic ${Buffer.from(`alice:${NTFY_PASSWORD}`).toString('base64')}`;
    expect(result.ntfy.map((r) => r.headers.authorization)).toEqual([basic, basic]);
  });

  it('approbation automatique : un évènement « auto_approved », à la place de « approuvée »', async () => {
    const { as, sent } = await setup({ enabled: ['outgoingWebhook'] });
    const request = await requestMovie(await as('auto_approve'));
    const { webhook } = await sent();
    expect(webhook).toHaveLength(1);
    expect(webhook[0]?.body).toMatchObject({
      type: 'auto_approved',
      title: 'Demande approuvée automatiquement',
      request: { id: request.id },
    });
  });

  it('un gestionnaire qui approuve sa propre demande à la main : « approved », pas « auto_approved »', async () => {
    const { as, sent } = await setup({ enabled: ['outgoingWebhook'] });
    // Demande faite en simple membre, approuvée une fois promu gestionnaire : ni lui ni personne n'a auto-approuvé.
    const request = await requestMovie(await as('member', 'promu'));
    const manager = await as('manager', 'promu');
    await manager.post(`/api/requests/${request.id}/approve`, {});
    const { webhook } = await sent();
    expect(webhook.map((r) => r.body.type)).toEqual(['requested', 'approved']);
  });

  it('configuration ancienne : « approved » sans « auto_approved » reçoit aussi les approbations automatiques', async () => {
    const { as, sent, data, saved } = await setup();
    setSetting(data.db, data.cryptoKey, 'outgoingWebhook', saved.outgoingWebhook);
    // Écriture directe : `setSetting` normaliserait déjà la liste, ce que ne faisait pas l'ancienne version.
    data.db.$client
      .prepare("UPDATE settings SET value = json_set(value, '$.events', json('[\"approved\"]')) WHERE key = ?")
      .run('outgoingWebhook');
    expect(getSetting(data.db, data.cryptoKey, 'outgoingWebhook')?.events).toEqual(['approved', 'auto_approved']);
    await requestMovie(await as('auto_approve'));
    expect((await sent()).webhook.map((r) => r.body.type)).toEqual(['auto_approved']);
  });

  it('configuration enregistrée (marqueur) : « approved » coché et « auto_approved » décoché le reste', async () => {
    const { as, data, saved } = await setup();
    const owner = await as('owner');
    await owner.put(agentSettingsPath('outgoingWebhook'), { ...saved.outgoingWebhook, events: ['approved'] });
    expect(getSetting(data.db, data.cryptoKey, 'outgoingWebhook')?.events).toEqual(['approved']);
    const reloaded = await owner.get(agentSettingsPath('outgoingWebhook'));
    expect(reloaded.json<{ events: string[] }>().events).toEqual(['approved']);
  });

  it('seuls les évènements choisis sont envoyés', async () => {
    const { as, sent, data, saved } = await setup();
    setSetting(data.db, data.cryptoKey, 'outgoingWebhook', { ...saved.outgoingWebhook, events: ['declined'] });
    const owner = await as('owner');
    const request = await requestMovie(await as('member'));
    expect((await sent()).webhook).toEqual([]);
    await owner.post(`/api/requests/${request.id}/decline`, { reason: 'Non merci' });
    expect((await sent()).webhook.map((r) => r.body.type)).toEqual(['declined']);
  });

  it('désactivé : aucun appel réseau, pas même vers TMDB', async () => {
    const { as, sent, tmdb, data, saved } = await setup();
    setSetting(data.db, data.cryptoKey, 'ntfy', { ...saved.ntfy, enabled: false });
    await requestMovie(await as('member'));
    // La demande elle-même lit TMDB ; les agents ne le relisent pas.
    const before = tmdb.requests.length;
    expect(await sent()).toEqual({ ntfy: [], telegram: [], webhook: [] });
    expect(tmdb.requests.length).toBe(before);
  });

  it('un agent en échec n’empêche ni les autres ni la demande, et son erreur est journalisée sans secret', async () => {
    const { as, sent, data, saved, app } = await setup({ enabled: ['telegram', 'outgoingWebhook'] });
    // ntfy répond 500 ; Telegram et le webhook répondent normalement.
    const broken = await startServer({ 'POST /': status(500, {}) });
    setSetting(data.db, data.cryptoKey, 'ntfy', { ...saved.ntfy, url: broken.url });
    const response = await (await as('member')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(response.statusCode).toBe(201);
    const result = await sent();
    await app.afterCommit.idle();

    expect(result.telegram).toHaveLength(1);
    expect(result.webhook).toHaveLength(1);
    expect(broken.requests).toHaveLength(1);
    const { entries } = app.logs.list({ level: 'error', q: '', limit: 10 });
    expect(entries).toHaveLength(1);
    const logged = JSON.stringify(entries);
    expect(logged).toContain('ntfy');
    for (const secret of [NTFY_TOKEN, BOT_TOKEN, AUTHORIZATION]) expect(logged).not.toContain(secret);
  });

  it('échec de Telegram : l’erreur journalisée ne contient pas le jeton, qui est dans l’adresse', async () => {
    const { app, as, sent } = await setup({ enabled: ['telegram'], reply: 400 });
    await requestMovie(await as('member'));
    await sent();
    const { entries } = app.logs.list({ level: 'error', q: '', limit: 10 });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(BOT_TOKEN);
  });
});

const NEW_KINDS = ['cancelled', 'issue_opened', 'issue_resolved'] as const;

describe('annulation et signalements', () => {
  /** Chaque agent a son propre choix : le webhook tout, ntfy `ntfy`, Telegram rien (valeur par défaut). */
  async function setupWithChoices(ntfy: readonly (typeof agentEventKinds)[number][]) {
    const ctx = await setup();
    const { db, cryptoKey } = ctx.data;
    setSetting(db, cryptoKey, 'outgoingWebhook', { ...ctx.saved.outgoingWebhook, events: [...agentEventKinds] });
    setSetting(db, cryptoKey, 'ntfy', { ...ctx.saved.ntfy, events: [...ntfy] });
    // Telegram enregistré sans `events` : il ne reçoit pas les nouveaux types.
    setSetting(db, cryptoKey, 'telegram', ctx.saved.telegram);
    return ctx;
  }

  it('un agent enregistré sans « events » a les six types historiques, pas les nouveaux', async () => {
    const { data, saved } = await setup();
    setSetting(data.db, data.cryptoKey, 'telegram', saved.telegram);
    const events = getSetting(data.db, data.cryptoKey, 'telegram')?.events;
    expect(events).toEqual([...defaultAgentEventKinds]);
    for (const kind of NEW_KINDS) expect(events).not.toContain(kind);
  });

  it('annulation : « cancelled » part seulement aux agents qui l’ont coché', async () => {
    const { as, sent } = await setupWithChoices(['cancelled']);
    const member = await as('member');
    const request = await requestMovie(member);
    const response = await member.post(`/api/requests/${request.id}/cancel`);
    expect(response.statusCode).toBe(200);

    const { ntfy, telegram, webhook } = await sent();
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0]?.body).toMatchObject({
      title: 'Demande annulée',
      message: `Matrix (1999)\nDemandé par ${member.user.name}`,
    });
    expect(telegram.map((r) => r.body.text)).toEqual([
      `Nouvelle demande à approuver\nMatrix (1999)\nDemandé par ${member.user.name}`,
    ]);
    expect(webhook.map((r) => r.body.type)).toEqual(['requested', 'cancelled']);
    expect(webhook[1]?.body).toEqual({
      type: 'cancelled',
      title: 'Demande annulée',
      message: `Matrix (1999)\nDemandé par ${member.user.name}`,
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      request: { id: request.id, status: 'cancelled' },
      user: { name: member.user.name },
      issue: null,
    } satisfies OutgoingWebhookPayload);
  });

  it('signalement créé puis résolu : « issue_opened » et « issue_resolved », pas à la réouverture', async () => {
    const { as, sent, data } = await setupWithChoices(['issue_opened']);
    data.db
      .insert(media)
      .values({ id: 1, type: 'movie', tmdbId: 603, status: 'available', statusUpdatedAt: new Date() })
      .run();
    const member = await as('member');
    const manager = await as('manager');
    const created = await member.post('/api/issues', {
      type: 'subtitles',
      mediaType: 'movie',
      tmdbId: 603,
      message: 'Sous-titres décalés',
    });
    expect(created.statusCode).toBe(201);
    const issue = created.json<IssueDetail>();
    expect((await manager.post(`/api/issues/${issue.id}/resolve`)).statusCode).toBe(200);
    // Les envois sont relus après la validation : celui de « résolu » finit avant la réouverture.
    await sent();
    expect((await manager.post(`/api/issues/${issue.id}/reopen`)).statusCode).toBe(200);

    const { ntfy, telegram, webhook } = await sent();
    expect(telegram).toEqual([]);
    expect(ntfy.map((r) => r.body.title)).toEqual(['Nouveau signalement']);
    expect(ntfy[0]?.body.message).toBe(`Matrix (1999)\nSignalé par ${member.user.name}\nProblème : Sous-titres`);
    expect(webhook.map((r) => r.body.type)).toEqual(['issue_opened', 'issue_resolved']);
    expect(webhook[0]?.body).toEqual({
      type: 'issue_opened',
      title: 'Nouveau signalement',
      message: `Matrix (1999)\nSignalé par ${member.user.name}\nProblème : Sous-titres`,
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      request: null,
      user: { name: member.user.name },
      issue: { id: issue.id, type: 'subtitles', status: 'open' },
    } satisfies OutgoingWebhookPayload);
    // Résolu : l'utilisateur est celui qui résout (le gestionnaire), pas l'auteur.
    expect(webhook[1]?.body).toEqual({
      type: 'issue_resolved',
      title: 'Signalement résolu',
      message: `Matrix (1999)\nRésolu par ${manager.user.name}\nProblème : Sous-titres`,
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      request: null,
      user: { name: manager.user.name },
      issue: { id: issue.id, type: 'subtitles', status: 'resolved' },
    } satisfies OutgoingWebhookPayload);
  });
});

describe.each(['ntfy', 'telegram', 'outgoingWebhook'] as const)('réglages %s', (key) => {
  const path = agentSettingsPath(key);
  const secrets = { ntfy: [NTFY_TOKEN], telegram: [BOT_TOKEN], outgoingWebhook: [AUTHORIZATION] }[key];

  it('par défaut : désactivé, les six évènements historiques, aucun secret', async () => {
    const { as } = await setup();
    const response = await (await as('owner')).get(path);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ enabled: false, events: defaultAgentEventKinds });
    if (key === 'ntfy') expect(body.url).toBe(NTFY_DEFAULT_URL);
    for (const value of Object.values(body)) expect(value).not.toEqual({ set: true });
  });

  it('propriétaire seulement', async () => {
    const { as, app } = await setup();
    const manager = await as('manager');
    expect((await manager.get(path)).statusCode).toBe(403);
    expect((await manager.put(path, { enabled: false })).statusCode).toBe(403);
    expect((await manager.post(agentTestPath(key), {})).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
  });

  it('les secrets sont chiffrés en base, jamais renvoyés, et gardés si le champ est vide', async () => {
    const { as, data, saved } = await setup();
    const owner = await as('owner');
    const form = saved[key];
    const put = await owner.put(path, form);
    expect(put.statusCode).toBe(200);
    for (const secret of secrets) {
      expect(put.body).not.toContain(secret);
      expect((await owner.get(path)).body).not.toContain(secret);
    }
    const row = data.db.$client.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string };
    for (const secret of secrets) expect(row.value).not.toContain(secret);
    expect(put.json<Record<string, unknown>>()).toMatchObject({ enabled: true });
    const before = getSetting(data.db, data.cryptoKey, key);

    // Secrets absents ou vides : on garde les enregistrés (même destination).
    const blank = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, secrets.includes(String(v)) ? '' : v]));
    const kept = await owner.put(path, blank);
    expect(kept.statusCode).toBe(200);
    // Le même réglage une fois déchiffré (chaque chiffrement a son aléa : les valeurs en base diffèrent).
    expect(getSetting(data.db, data.cryptoKey, key)).toEqual(before);
  });

  it('activer sans la configuration requise est refusé', async () => {
    const { as } = await setup();
    const response = await (await as('owner')).put(path, { enabled: true });
    expect(response.statusCode).toBe(400);
  });

  it('évènement inconnu refusé', async () => {
    const { as } = await setup();
    expect((await (await as('owner')).put(path, { events: ['inconnu'] })).statusCode).toBe(400);
  });

  it('Tester envoie un message de test avec les valeurs saisies, sans rien enregistrer', async () => {
    const { as, sent, data, saved } = await setup();
    const response = await (await as('owner')).post(agentTestPath(key), saved[key]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const result = await sent();
    const message = { ntfy: result.ntfy, telegram: result.telegram, outgoingWebhook: result.webhook }[key];
    expect(message).toHaveLength(1);
    expect(JSON.stringify(message[0]?.body)).toContain('Test de Request');
    expect(data.db.$client.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)).toBeUndefined();
  });

  it('Tester réutilise les secrets enregistrés quand le champ est vide', async () => {
    const { as, sent, saved } = await setup({ enabled: [key] });
    const blank = Object.fromEntries(
      Object.entries(saved[key]).map(([k, v]) => [k, secrets.includes(String(v)) ? '' : v]),
    );
    const owner = await as('owner');
    expect((await owner.post(agentTestPath(key), blank)).statusCode).toBe(200);
    expect((await owner.post(agentTestPath(key), {})).statusCode).toBe(200);
    const result = await sent();
    const received = { ntfy: result.ntfy, telegram: result.telegram, outgoingWebhook: result.webhook }[key];
    expect(received).toHaveLength(2);
    if (key === 'outgoingWebhook') expect(received[0]?.headers.authorization).toBe(AUTHORIZATION);
    if (key === 'ntfy') expect(received[1]?.headers.authorization).toBe(`Bearer ${NTFY_TOKEN}`);
  });

  it('sans configuration → 409, sans appel ; refus du service → 422 sans le secret', async () => {
    const empty = await setup();
    const owner = await empty.as('owner');
    expect((await owner.post(agentTestPath(key), {})).statusCode).toBe(409);
    expect(await empty.sent()).toEqual({ ntfy: [], telegram: [], webhook: [] });

    const refused = await setup({ enabled: [key], reply: 404 });
    const response = await (await refused.as('owner')).post(agentTestPath(key), {});
    expect(response.statusCode).toBe(422);
    for (const secret of secrets) expect(response.body).not.toContain(secret);
  });
});

describe('destination des secrets enregistrés', () => {
  it('ntfy : le jeton enregistré n’est jamais envoyé à une autre adresse ou un autre sujet', async () => {
    const { as, saved, data, ntfy } = await setup({ enabled: ['ntfy'] });
    const other = await startServer({ 'POST /': status(200, {}) });
    const owner = await as('owner');
    // Même sujet, autre serveur : le jeton ne suit pas.
    await owner.post(agentTestPath('ntfy'), { url: other.url, topic: 'demandes' });
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    // Même serveur, autre sujet : idem.
    await owner.post(agentTestPath('ntfy'), { ...saved.ntfy, token: '', topic: 'autre' });
    expect(ntfy.requests.at(-1)?.headers.authorization).toBeUndefined();
    // Enregistrer vers une autre adresse sans jeton : le jeton enregistré n'est pas repris.
    await owner.put(agentSettingsPath('ntfy'), { enabled: true, url: other.url, topic: 'demandes' });
    const row = data.db.$client.prepare("SELECT value FROM settings WHERE key = 'ntfy'").get() as { value: string };
    expect(row.value).toContain('"token":null');
  });

  it('un secret mis à null est supprimé (jeton ntfy, en-tête du webhook)', async () => {
    const { as, saved, data } = await setup({ enabled: ['ntfy', 'outgoingWebhook'] });
    const owner = await as('owner');
    await owner.put(agentSettingsPath('ntfy'), { ...saved.ntfy, token: null });
    await owner.put(agentSettingsPath('outgoingWebhook'), { ...saved.outgoingWebhook, authorization: null });
    expect(getSetting(data.db, data.cryptoKey, 'ntfy')?.token).toBeNull();
    expect(getSetting(data.db, data.cryptoKey, 'outgoingWebhook')?.authorization).toBeNull();
  });

  it('webhook sortant : l’en-tête enregistré ne suit pas une autre adresse', async () => {
    const { as, saved, webhook } = await setup({ enabled: ['outgoingWebhook'] });
    const other = await startServer({ 'POST /': status(200, {}) });
    await (await as('owner')).post(agentTestPath('outgoingWebhook'), { url: other.url, authorization: '' });
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(webhook.requests).toEqual([]);
    expect(saved.outgoingWebhook.authorization).toBe(AUTHORIZATION);
  });
});

describe('validation', () => {
  it('ntfy : sujet, adresse ; Telegram : jeton du bot ; webhook : adresse et en-tête', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    const put = async (key: AgentKey, value: object) => (await owner.put(agentSettingsPath(key), value)).statusCode;
    expect(await put('ntfy', { topic: 'avec/barre' })).toBe(400);
    expect(await put('ntfy', { url: 'pas une adresse', topic: 'ok' })).toBe(400);
    expect(await put('ntfy', { url: 'http://ntfy.local:8080/', topic: 'ok' })).toBe(200);
    expect(await put('telegram', { botToken: '../../etc' })).toBe(400);
    expect(await put('telegram', { botToken: BOT_TOKEN, chatId: '', enabled: true })).toBe(400);
    expect(await put('telegram', { botToken: BOT_TOKEN, chatId: '@canal', threadId: 0 })).toBe(400);
    expect(await put('telegram', { botToken: BOT_TOKEN, chatId: '@canal', enabled: true })).toBe(200);
    expect(await put('outgoingWebhook', { url: 'ftp://exemple.fr/x' })).toBe(400);
    expect(await put('outgoingWebhook', { url: 'https://exemple.fr/x', authorization: 'a\nb' })).toBe(400);
    expect(await put('outgoingWebhook', { url: 'https://exemple.fr/x', authorization: 'Bearer abc' })).toBe(200);
  });

  it('chaque agent a sa propre adresse d’API', () => {
    expect(new Set(agentKeys.map(agentSettingsPath)).size).toBe(agentKeys.length);
  });
});
