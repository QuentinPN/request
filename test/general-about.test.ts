import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { media, requests } from '../src/server/db/schema.ts';
import type { MailMessage } from '../src/server/services/email.ts';
import {
  ABOUT_PATH,
  APP_TITLE_MAX,
  aboutSchema,
  DEFAULT_APP_TITLE,
  GENERAL_SETTINGS_PATH,
} from '../src/shared/app-info.ts';
import { NOTIFICATION_PREFERENCES_PATH, SMTP_SETTINGS_PATH, SMTP_TEST_PATH } from '../src/shared/notifications.ts';
import { SETUP_STATE_PATH } from '../src/shared/setup.ts';
import { requestStatuses } from '../src/shared/status.ts';
import { loginAs, trackApps, trackTempDirs } from './helpers.ts';

const newApp = trackApps();
const tempDir = trackTempDirs();

async function as(app: Awaited<ReturnType<typeof newApp>>, role: 'owner' | 'manager' | 'member') {
  const { headers } = await loginAs(app, role);
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers, payload }),
    post: (url: string, payload?: object) => app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
  };
}

describe('Réglages › Général', () => {
  it('propriétaire seulement', async () => {
    const app = await newApp();
    for (const role of ['manager', 'member'] as const) {
      const user = await as(app, role);
      expect((await user.get(GENERAL_SETTINGS_PATH)).statusCode).toBe(403);
      expect((await user.put(GENERAL_SETTINGS_PATH, { appTitle: 'Autre' })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: GENERAL_SETTINGS_PATH })).statusCode).toBe(401);
  });

  it('titre par défaut, puis enregistré (sans espaces autour) et public dans l’état de l’installation', async () => {
    const app = await newApp();
    const owner = await as(app, 'owner');
    expect((await owner.get(GENERAL_SETTINGS_PATH)).json()).toEqual({ appTitle: DEFAULT_APP_TITLE });
    expect((await app.inject({ method: 'GET', url: SETUP_STATE_PATH })).json().appTitle).toBe(DEFAULT_APP_TITLE);

    const saved = await owner.put(GENERAL_SETTINGS_PATH, { appTitle: '  Cinéma maison  ' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ appTitle: 'Cinéma maison' });
    expect((await owner.get(GENERAL_SETTINGS_PATH)).json()).toEqual({ appTitle: 'Cinéma maison' });
    // Sans session : l'onglet de la page de connexion porte aussi le titre.
    expect((await app.inject({ method: 'GET', url: SETUP_STATE_PATH })).json().appTitle).toBe('Cinéma maison');
  });

  it('refuse un titre vide, d’espaces ou de plus de 40 caractères', async () => {
    const app = await newApp();
    const owner = await as(app, 'owner');
    await owner.put(GENERAL_SETTINGS_PATH, { appTitle: 'Gardé' });
    for (const appTitle of ['', '   ', 'x'.repeat(APP_TITLE_MAX + 1), 12, 'Deux\nlignes', 'Tab\tulation']) {
      expect((await owner.put(GENERAL_SETTINGS_PATH, { appTitle })).statusCode).toBe(400);
    }
    expect((await owner.put(GENERAL_SETTINGS_PATH, { appTitle: 'x'.repeat(APP_TITLE_MAX) })).statusCode).toBe(200);
  });

  it('le titre figure dans les textes envoyés aux membres (courriel d’essai)', async () => {
    const mails: MailMessage[] = [];
    const app = await buildApp({
      data: openDataDir(tempDir()),
      upstreams: { mailTransport: () => ({ sendMail: async (message) => void mails.push(message) }) },
      publicUrl: null,
    });
    const owner = await as(app, 'owner');
    await owner.put(SMTP_SETTINGS_PATH, {
      host: 'smtp.exemple.fr',
      port: 587,
      security: 'starttls',
      from: 'appli@exemple.fr',
    });
    await owner.put(NOTIFICATION_PREFERENCES_PATH, {
      email: 'proprio@exemple.fr',
      emailNotifications: true,
      pushNotifications: true,
    });
    await owner.post(SMTP_TEST_PATH, {});
    await owner.put(GENERAL_SETTINGS_PATH, { appTitle: 'Cinéma maison' });
    await owner.post(SMTP_TEST_PATH, {});
    expect(mails.map((m) => m.subject)).toEqual(['Essai de Request', 'Essai de Cinéma maison']);
    expect(mails[1]?.html).toContain('Cinéma maison');
    expect(mails[1]?.html).not.toContain('Request');
    await app.close();
  });
});

describe('Réglages › À propos', () => {
  it('propriétaire seulement', async () => {
    const app = await newApp();
    for (const role of ['manager', 'member'] as const)
      expect((await (await as(app, role)).get(ABOUT_PATH)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: ABOUT_PATH })).statusCode).toBe(401);
  });

  it('version, environnement et compteurs ; commit inconnu sans GIT_SHA', async () => {
    vi.stubEnv('GIT_SHA', '');
    const app = await newApp();
    const owner = await as(app, 'owner');
    const response = await owner.get(ABOUT_PATH);
    expect(response.statusCode).toBe(200);
    const about = aboutSchema.parse(response.json());
    expect(about).toMatchObject({
      commit: null,
      node: process.version,
      dataDir: app.data.dir,
      counts: { members: 1, media: 0, requests: 0 },
    });
    expect(about.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(about.timeZone).not.toBe('');
    expect(about.databaseBytes).toBeGreaterThan(0);
    expect(Object.keys(about.counts.requestsByStatus).sort()).toEqual([...requestStatuses].sort());
    vi.unstubAllEnvs();
  });

  it('commit abrégé à 7 caractères quand GIT_SHA est fixé', async () => {
    vi.stubEnv('GIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    const app = await newApp();
    expect((await (await as(app, 'owner')).get(ABOUT_PATH)).json().commit).toBe('0123456');
    vi.unstubAllEnvs();
  });

  it('compte les membres, les titres suivis et les demandes par statut', async () => {
    const app = await newApp();
    const owner = await as(app, 'owner');
    await as(app, 'member');
    const { db } = app.data;
    const ids = db
      .insert(media)
      .values([
        { type: 'movie', tmdbId: 1, statusUpdatedAt: new Date(0) },
        { type: 'tv', tmdbId: 2, statusUpdatedAt: new Date(0) },
      ])
      .returning({ id: media.id })
      .all();
    const [first, second] = ids.map((m) => m.id) as [number, number];
    db.insert(requests)
      .values([
        { mediaId: first, userId: 'membre-member', status: 'pending' },
        { mediaId: second, userId: 'membre-member', status: 'pending' },
        { mediaId: first, userId: 'membre-owner', status: 'available' },
      ])
      .run();

    const { counts } = aboutSchema.parse((await owner.get(ABOUT_PATH)).json());
    expect(counts).toMatchObject({ members: 2, media: 2, requests: 3 });
    expect(counts.requestsByStatus).toMatchObject({ pending: 2, available: 1, approved: 0, failed: 0 });
  });
});
