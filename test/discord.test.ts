import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { setSetting } from '../src/server/services/settings.ts';
import { createSync } from '../src/server/services/sync.ts';
import { DISCORD_SETTINGS_PATH, DISCORD_TEST_PATH } from '../src/shared/discord.ts';
import { type RequestNotificationKind, requestNotificationKinds } from '../src/shared/notifications.ts';
import type { RequestDetail } from '../src/shared/requests.ts';
import type { Role } from '../src/shared/roles.ts';
import { status } from './fake-server.ts';
import { loginAs, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const TOKEN = 'jeton-secret-du-webhook';
const WEBHOOK = `https://discord.com/api/webhooks/123456/${TOKEN}`;
const WEBHOOK_PATH = `/api/webhooks/123456/${TOKEN}`;

const matrix = {
  id: 603,
  title: 'Matrix',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};

interface DiscordMessage {
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    thumbnail?: { url: string };
  }>;
  allowed_mentions: { parse: string[] };
}

/** Appli branchée sur de faux TMDB, Radarr et Discord ; le webhook n'est enregistré que si `discord` est fourni. */
async function setup(discord?: { enabled?: boolean; events?: readonly RequestNotificationKind[]; reply?: number }) {
  const radarrState = { movies: [] as Array<{ id: number; tmdbId: number; hasFile: boolean }>, down: false };
  const tmdb = await startServer({ 'GET /movie/603': matrix });
  const radarr = await startServer({
    'GET /api/v3/movie': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(radarrState.movies.map((m) => ({ ...m, monitored: true }))));
    },
    'GET /api/v3/queue': { totalRecords: 0, records: [] },
    'GET /api/v3/movie/lookup/tmdb': { id: 0, title: 'The Matrix', tmdbId: 603, hasFile: false, monitored: false },
    'POST /api/v3/movie': (req, res) =>
      radarrState.down
        ? status(500, { message: 'panne' })(req, res)
        : status(201, { id: 42, hasFile: false, monitored: true })(req, res),
  });
  const fake = await startServer({ [`POST ${WEBHOOK_PATH}`]: status(discord?.reply ?? 204) });
  const data = openDataDir(tempDir());
  const { db, cryptoKey } = data;
  setSetting(db, cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
  setSetting(db, cryptoKey, 'radarr', { url: radarr.url, apiKey: 'k', qualityProfileId: 1, rootFolderPath: '/films' });
  if (discord)
    setSetting(db, cryptoKey, 'discord', {
      webhookUrl: WEBHOOK,
      enabled: discord.enabled ?? true,
      ...(discord.events && { events: [...discord.events] }),
    });
  const app = await buildApp({ data, upstreams: { tmdbUrl: tmdb.url, discordUrl: fake.url } });
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
  /** Messages reçus par Discord, une fois les envois planifiés terminés. */
  const sent = async () => {
    await app.discord.idle();
    return fake.requests.map((r) => ({ path: r.path, method: r.method, message: r.body as DiscordMessage }));
  };
  return { app, data, radarrState, fake, tmdb, as, sent };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Actor = Awaited<ReturnType<Setup['as']>>;

const requestMovie = async (actor: Actor) =>
  (await actor.post('/api/requests', { type: 'movie', tmdbId: 603 })).json<RequestDetail>();

describe('messages Discord des évènements', () => {
  it('une demande à approuver : un seul message pour tous les gestionnaires, en français, avec l’affiche TMDB', async () => {
    const { as, sent } = await setup({});
    const member = await as('member');
    await as('manager');
    await as('owner');
    await requestMovie(member);

    const messages = await sent();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'POST', path: WEBHOOK_PATH });
    const message = messages[0]?.message;
    expect(message?.allowed_mentions).toEqual({ parse: [] });
    expect(message?.embeds).toHaveLength(1);
    expect(message?.embeds[0]).toMatchObject({
      title: 'Nouvelle demande à approuver',
      description: '**Matrix** (1999)',
      fields: [{ name: 'Demandé par', value: member.user.name, inline: true }],
      // TMDB est public ; /api/images ne l'est pas.
      thumbnail: { url: 'https://image.tmdb.org/t/p/w342/matrix.jpg' },
    });
  });

  it('approuvée puis disponible : un message chacun', async () => {
    const { app, data, radarrState, as, sent } = await setup({});
    const owner = await as('owner');
    const request = await requestMovie(await as('member'));
    await owner.post(`/api/requests/${request.id}/approve`);
    radarrState.movies.push({ id: 42, tmdbId: 603, hasFile: true });
    await createSync(data, { availability: app.availability }).handleWebhook('radarr', {
      eventType: 'Download',
      movie: { tmdbId: 603 },
    });

    // Les envois sont simultanés : l'ordre d'arrivée n'est pas garanti.
    const titles = (await sent()).map((m) => m.message.embeds[0]?.title);
    expect(titles.sort()).toEqual(['Demande approuvée', 'Disponible dans Emby', 'Nouvelle demande à approuver']);
  });

  it('refusée avec son motif, puis échec d’envoi avec sa raison', async () => {
    const { radarrState, as, sent } = await setup({});
    const member = await as('member');
    const owner = await as('owner');
    await owner.post(`/api/requests/${(await requestMovie(member)).id}/decline`, { reason: 'Déjà en VO' });
    radarrState.down = true;
    await owner.post(`/api/requests/${(await requestMovie(member)).id}/approve`);

    // Les envois sont simultanés : on retrouve chaque message par son titre.
    const embeds = (await sent()).flatMap((m) => m.message.embeds);
    expect(embeds.map((e) => e.title).sort()).toEqual([
      'Demande approuvée',
      'Demande refusée',
      'Nouvelle demande à approuver',
      'Nouvelle demande à approuver',
      'Échec de l’envoi',
    ]);
    const byTitle = (title: string) => embeds.find((e) => e.title === title);
    expect(byTitle('Demande refusée')?.fields).toContainEqual({ name: 'Motif', value: 'Déjà en VO' });
    expect(byTitle('Échec de l’envoi')?.fields.map((f) => f.name)).toEqual(['Demandé par', 'Raison']);
  });

  it('une demande d’un rôle à approbation automatique n’est pas « à approuver »', async () => {
    const { as, sent } = await setup({});
    await requestMovie(await as('auto_approve'));
    expect((await sent()).map((m) => m.message.embeds[0]?.title)).toEqual(['Demande approuvée']);
  });

  it('seuls les évènements choisis sont envoyés', async () => {
    const declined = await setup({ events: ['declined'] });
    const request = await requestMovie(await declined.as('member'));
    await (await declined.as('owner')).post(`/api/requests/${request.id}/decline`, { reason: 'Non merci' });
    expect((await declined.sent()).map((m) => m.message.embeds[0]?.title)).toEqual(['Demande refusée']);

    const approved = await setup({ events: ['approved', 'failed'] });
    const other = await requestMovie(await approved.as('member'));
    await (await approved.as('owner')).post(`/api/requests/${other.id}/approve`);
    expect((await approved.sent()).map((m) => m.message.embeds[0]?.title)).toEqual(['Demande approuvée']);
  });

  it('désactivé, ou sans adresse : aucun appel réseau', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const config of [{ enabled: false }, undefined]) {
      const { as, sent, fake } = await setup(config);
      const owner = await as('owner');
      const request = await requestMovie(await as('member'));
      expect((await owner.post(`/api/requests/${request.id}/decline`, { reason: 'Non merci' })).statusCode).toBe(200);
      expect(await sent()).toEqual([]);
      expect(fake.requests).toEqual([]);
    }
    const called = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(called.some((url) => url.includes('/api/webhooks/'))).toBe(false);
  });

  it('un évènement absent de la base (transaction annulée) n’est pas envoyé', async () => {
    const { app, as, sent } = await setup({});
    const request = await requestMovie(await as('member'));
    const before = (await sent()).length;
    app.discord.enqueue({ requestId: request.id, type: 'declined', actorId: null, detail: null, at: new Date() });
    expect(await sent()).toHaveLength(before);
  });

  it('échec de Discord : l’action du membre réussit, l’erreur est journalisée sans l’adresse', async () => {
    const { as, sent } = await setup({ reply: 500 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await (await as('member')).post('/api/requests', { type: 'movie', tmdbId: 603 });
    expect(response.statusCode).toBe(201);

    // Un seul appel : pas de nouvelle tentative.
    expect(await sent()).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain('discord.com');
  });
});

describe('réglages Discord', () => {
  it('par défaut : désactivé, tous les évènements, aucune adresse', async () => {
    const { as } = await setup();
    const response = await (await as('owner')).get(DISCORD_SETTINGS_PATH);
    expect(response.json()).toEqual({ webhookUrl: { set: false }, enabled: false, events: requestNotificationKinds });
  });

  it('propriétaire seulement', async () => {
    const { as, app } = await setup();
    const manager = await as('manager');
    expect((await manager.get(DISCORD_SETTINGS_PATH)).statusCode).toBe(403);
    expect((await manager.put(DISCORD_SETTINGS_PATH, { enabled: false })).statusCode).toBe(403);
    expect((await manager.post(DISCORD_TEST_PATH, {})).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: DISCORD_SETTINGS_PATH })).statusCode).toBe(401);
  });

  it('l’adresse est un secret : chiffrée en base, jamais renvoyée, gardée si le champ est vide', async () => {
    const { as, data } = await setup();
    const owner = await as('owner');
    const saved = await owner.put(DISCORD_SETTINGS_PATH, { webhookUrl: WEBHOOK, enabled: true, events: ['failed'] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ webhookUrl: { set: true }, enabled: true, events: ['failed'] });
    expect(saved.body).not.toContain(TOKEN);
    expect((await owner.get(DISCORD_SETTINGS_PATH)).body).not.toContain(TOKEN);

    const row = data.db.$client.prepare("SELECT value FROM settings WHERE key = 'discord'").get() as { value: string };
    expect(row.value).not.toContain(TOKEN);

    // Champ vide ou absent : on garde l'adresse enregistrée.
    const kept = await owner.put(DISCORD_SETTINGS_PATH, { webhookUrl: '', enabled: false, events: ['failed'] });
    expect(kept.json()).toEqual({ webhookUrl: { set: true }, enabled: false, events: ['failed'] });
    expect((await owner.put(DISCORD_SETTINGS_PATH, { enabled: true })).statusCode).toBe(200);
  });

  it.each([
    ['http://discord.com/api/webhooks/1/abc', 'pas en https'],
    ['https://evil.example/api/webhooks/1/abc', 'autre hôte'],
    ['https://discord.com.evil.example/api/webhooks/1/abc', 'hôte qui commence par discord.com'],
    ['https://discord.com/channels/1/2', 'autre chemin'],
    ['https://discord.com/', 'sans chemin de webhook'],
    ['pas une adresse', 'texte libre'],
  ])('refuse %s (%s)', async (webhookUrl) => {
    const { as } = await setup();
    const owner = await as('owner');
    expect((await owner.put(DISCORD_SETTINGS_PATH, { webhookUrl, enabled: true })).statusCode).toBe(400);
    expect((await owner.get(DISCORD_SETTINGS_PATH)).json()).toMatchObject({ webhookUrl: { set: false } });
  });

  it('accepte discord.com et discordapp.com ; activer sans adresse est refusé', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    expect((await owner.put(DISCORD_SETTINGS_PATH, { enabled: true })).statusCode).toBe(400);
    for (const host of ['discord.com', 'discordapp.com'])
      expect(
        (await owner.put(DISCORD_SETTINGS_PATH, { webhookUrl: `https://${host}/api/webhooks/1/abc`, enabled: true }))
          .statusCode,
      ).toBe(200);
  });

  it('évènement inconnu refusé', async () => {
    const { as } = await setup();
    expect((await (await as('owner')).put(DISCORD_SETTINGS_PATH, { events: ['inconnu'] })).statusCode).toBe(400);
  });
});

describe('Tester', () => {
  it('poste un message de test avec l’adresse enregistrée', async () => {
    const { as, sent } = await setup({ enabled: false });
    const response = await (await as('owner')).post(DISCORD_TEST_PATH);
    expect(response.statusCode).toBe(200);
    const [message] = await sent();
    expect(message?.path).toBe(WEBHOOK_PATH);
    expect(message?.message.embeds[0]).toMatchObject({ title: 'Test de Request' });
  });

  it('sans adresse → 409, sans appel', async () => {
    const { as, fake } = await setup();
    const response = await (await as('owner')).post(DISCORD_TEST_PATH, {});
    expect(response.statusCode).toBe(409);
    expect(fake.requests).toEqual([]);
  });

  it('adresse saisie invalide → 400 ; webhook supprimé (404) → 422 sans le jeton', async () => {
    const { as } = await setup({ reply: 404 });
    const owner = await as('owner');
    expect((await owner.post(DISCORD_TEST_PATH, { webhookUrl: 'https://evil.example/x' })).statusCode).toBe(400);
    const response = await owner.post(DISCORD_TEST_PATH);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Webhook introuvable : a-t-il été supprimé dans Discord ?' });
    expect(response.body).not.toContain(TOKEN);
  });
});
