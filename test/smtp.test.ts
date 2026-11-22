import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { settings } from '../src/server/db/schema.ts';
import {
  createEmail,
  type MailMessage,
  type MailTransport,
  mailContent,
  SMTP_TEST_DEADLINE_MS,
} from '../src/server/services/email.ts';
import { withStoredSecrets } from '../src/server/services/settings.ts';
import {
  AGENT_EVENTS_VERSION,
  NOTIFICATION_PREFERENCES_PATH,
  notificationKinds,
  SERVICE_WORKER_PATH,
  SMTP_SETTINGS_PATH,
  SMTP_TEST_PATH,
} from '../src/shared/notifications.ts';
import type { SettingInput } from '../src/shared/settings.ts';
import { loginAs, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SMTP: SettingInput<'smtp'> = {
  host: 'smtp.exemple.fr',
  port: 587,
  security: 'starttls',
  username: 'appli',
  password: 'mot-de-passe-smtp',
  from: 'appli@exemple.fr',
};
/** Formulaire au mot de passe laissé vide (le client ne l'envoie pas). */
const { password: _, ...NO_PASSWORD } = SMTP;

async function setup() {
  const mails: Array<MailMessage & { host: string; password: string | null }> = [];
  const state = { fail: null as string | null };
  const mailTransport: MailTransport = (config) => ({
    sendMail: async (message) => {
      if (state.fail) throw Object.assign(new Error('refus'), { code: state.fail });
      mails.push({ ...message, host: config.host, password: config.password });
    },
  });
  const data = openDataDir(tempDir());
  const app = await buildApp({ data, upstreams: { mailTransport }, publicUrl: null });
  cleanups.push(() => app.close());
  const as = async (role: 'owner' | 'manager') => {
    const { headers } = await loginAs(app, role);
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers, payload }),
      post: (url: string, payload?: object) =>
        app.inject({ method: 'POST', url, headers, ...(payload && { payload }) }),
    };
  };
  return { app, data, mails, state, as };
}

describe('réglage SMTP', () => {
  it('propriétaire seulement', async () => {
    const { as } = await setup();
    const manager = await as('manager');
    expect((await manager.get(SMTP_SETTINGS_PATH)).statusCode).toBe(403);
    expect((await manager.put(SMTP_SETTINGS_PATH, SMTP)).statusCode).toBe(403);
    expect((await manager.post(SMTP_TEST_PATH, {})).statusCode).toBe(403);
  });

  it('types envoyés par courriel : tous par défaut, ceux cochés enregistrés, un type inconnu refusé', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    const chosen = await owner.put(SMTP_SETTINGS_PATH, { ...SMTP, events: ['issue_created', 'declined'] });
    expect(chosen.json()).toMatchObject({ events: ['issue_created', 'declined'] });
    expect((await owner.put(SMTP_SETTINGS_PATH, { ...SMTP, events: ['inconnu'] })).statusCode).toBe(400);
  });

  it('le mot de passe est chiffré, jamais renvoyé, gardé si le champ est vide', async () => {
    const { as, data } = await setup();
    const owner = await as('owner');
    expect((await owner.get(SMTP_SETTINGS_PATH)).statusCode).toBe(404);
    const saved = await owner.put(SMTP_SETTINGS_PATH, SMTP);
    expect(saved.json()).toEqual({
      ...SMTP,
      enabled: true,
      events: notificationKinds,
      eventsVersion: AGENT_EVENTS_VERSION,
      password: { set: true },
    });
    expect((await owner.get(SMTP_SETTINGS_PATH)).body).not.toContain('mot-de-passe-smtp');
    const raw = data.db.select().from(settings).where(eq(settings.key, 'smtp')).get()?.value ?? '';
    expect(raw).not.toContain('mot-de-passe-smtp');

    const kept = await owner.put(SMTP_SETTINGS_PATH, { ...SMTP, password: '', from: 'autre@exemple.fr' });
    expect(kept.json()).toMatchObject({ from: 'autre@exemple.fr', password: { set: true } });
  });

  it('autre hôte, port, chiffrement ou identifiant : le mot de passe enregistré ne le suit pas', async () => {
    const { as } = await setup();
    const owner = await as('owner');
    await owner.put(SMTP_SETTINGS_PATH, SMTP);
    for (const change of [
      { host: 'piege.exemple.com' },
      { port: 2525 },
      { security: 'none' as const },
      { username: 'autre' },
    ]) {
      const response = await owner.put(SMTP_SETTINGS_PATH, { ...NO_PASSWORD, ...change });
      expect(response.json()).toMatchObject({ ...change, password: { set: false } });
      await owner.put(SMTP_SETTINGS_PATH, SMTP);
    }
  });

  it('essai : à l’adresse du propriétaire, avec le réglage saisi ; 409 sans adresse', async () => {
    const { as, mails } = await setup();
    const owner = await as('owner');
    await owner.put(SMTP_SETTINGS_PATH, SMTP);
    expect((await owner.post(SMTP_TEST_PATH, {})).json()).toEqual({
      error: 'Renseignez d’abord votre adresse courriel dans Compte',
    });
    await owner.put(NOTIFICATION_PREFERENCES_PATH, {
      email: 'proprio@exemple.fr',
      emailNotifications: true,
      pushNotifications: true,
    });

    expect((await owner.post(SMTP_TEST_PATH, {})).statusCode).toBe(200);
    // Formulaire non enregistré, même serveur : le mot de passe enregistré sert ; autre serveur : il ne sert pas.
    expect((await owner.post(SMTP_TEST_PATH, { ...NO_PASSWORD, from: 'essai@exemple.fr' })).statusCode).toBe(200);
    expect((await owner.post(SMTP_TEST_PATH, { ...NO_PASSWORD, host: 'piege.exemple.com' })).statusCode).toBe(200);
    expect(mails.map((m) => [m.to, m.from, m.host, m.password, m.subject])).toEqual([
      ['proprio@exemple.fr', 'appli@exemple.fr', 'smtp.exemple.fr', 'mot-de-passe-smtp', 'Essai de Request'],
      ['proprio@exemple.fr', 'essai@exemple.fr', 'smtp.exemple.fr', 'mot-de-passe-smtp', 'Essai de Request'],
      ['proprio@exemple.fr', 'appli@exemple.fr', 'piege.exemple.com', null, 'Essai de Request'],
    ]);
  });

  it('essai refusé : 422 avec un message lisible', async () => {
    const { as, state } = await setup();
    const owner = await as('owner');
    await owner.put(NOTIFICATION_PREFERENCES_PATH, {
      email: 'proprio@exemple.fr',
      emailNotifications: true,
      pushNotifications: true,
    });
    state.fail = 'EAUTH';
    const response = await owner.post(SMTP_TEST_PATH, SMTP);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Identifiant ou mot de passe refusé par le serveur SMTP' });
  });

  it('essai : un serveur qui ne finit jamais échoue au délai total, en 422', async () => {
    const data = openDataDir(tempDir());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hanging: MailTransport = () => ({ sendMail: () => new Promise(() => undefined) });
      const email = createEmail(data, { transport: hanging, publicUrl: null });
      const config = {
        ...SMTP,
        port: 587,
        security: 'starttls' as const,
        enabled: true,
        username: null,
        password: null,
        events: [...notificationKinds],
      };
      const attempt = email.test(config, 'proprio@exemple.fr');
      // Issue relevée sans attendre la promesse : sous Bun, `expect(promesse).rejects` attend sur place une promesse
      // encore en cours, sans délai de test, et un délai SMTP cassé bloquerait la suite au lieu d'échouer.
      let outcome: unknown = 'toujours en cours';
      attempt.then(
        () => {
          outcome = 'réussi';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(SMTP_TEST_DEADLINE_MS);
      expect(outcome).toMatchObject({ statusCode: 422, message: 'Le serveur SMTP n’a pas répondu à temps' });
    } finally {
      vi.useRealTimers();
      data.db.$client.close(true);
    }
  });
});

describe('withStoredSecrets', () => {
  const stored = { url: 'http://192.0.2.20:8096', apiKey: 'cle' };

  it('adresse : même service (au `/` final près) seulement', () => {
    expect(withStoredSecrets('emby', { url: 'http://192.0.2.20:8096/', apiKey: '' }, stored)).toMatchObject({
      apiKey: 'cle',
    });
    expect(withStoredSecrets('emby', { url: 'http://piege:8096', apiKey: '' }, stored)).toMatchObject({ apiKey: '' });
  });

  it('SMTP : même hôte, port, chiffrement et identifiant seulement (le réglage n’a pas d’adresse)', () => {
    const smtp = { ...SMTP, enabled: true };
    expect(withStoredSecrets('smtp', { ...SMTP, host: ' smtp.exemple.fr ', password: '' }, smtp)).toMatchObject({
      password: 'mot-de-passe-smtp',
    });
    expect(withStoredSecrets('smtp', { ...SMTP, host: 'piege', password: '' }, smtp)).toMatchObject({ password: '' });
    // Sans chiffrement, le mot de passe partirait en clair : il n'est pas réutilisé.
    expect(withStoredSecrets('smtp', { ...SMTP, security: 'none', password: '' }, smtp)).toMatchObject({
      password: '',
    });
  });
});

describe('gabarit de courriel', () => {
  it('texte et HTML ; lien seulement si l’adresse publique est connue', () => {
    const message = {
      title: 'Demande approuvée',
      body: 'Votre demande de « A & B » a été approuvée.',
      path: '/titre/movie/1',
    };
    const linked = mailContent(message, 'https://demandes.exemple.fr', 'Request');
    expect(linked.subject).toBe('Demande approuvée');
    expect(linked.text).toContain('Ouvrir Request : https://demandes.exemple.fr/titre/movie/1');
    expect(linked.html).toContain('href="https://demandes.exemple.fr/titre/movie/1"');
    expect(linked.html).toContain('« A &amp; B »');
    const plain = mailContent(message, null, 'Request');
    expect(plain.text).not.toContain('Ouvrir');
    expect(plain.html).not.toContain('href');
  });
});

describe('appli installable', () => {
  it('manifeste et service worker servis à la racine, avec leurs types ; le service worker n’est pas mis en cache', async () => {
    const app = await buildApp({ data: openDataDir(tempDir()), clientDir: resolve(import.meta.dirname, '../public') });
    cleanups.push(() => app.close());
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(manifest.json()).toMatchObject({
      name: 'Request',
      start_url: '/',
      display: 'standalone',
      icons: expect.arrayContaining([expect.objectContaining({ purpose: 'maskable' })]),
    });

    const worker = await app.inject({ method: 'GET', url: SERVICE_WORKER_PATH });
    expect(worker.statusCode).toBe(200);
    expect(worker.headers['content-type']).toMatch(/javascript/);
    expect(worker.headers['cache-control']).toBe('no-cache');
    expect(worker.body).toContain("addEventListener('push'");

    expect((await app.inject({ method: 'GET', url: '/hors-ligne.html' })).statusCode).toBe(200);
    for (const icon of ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'])
      expect((await app.inject({ method: 'GET', url: icon })).headers['content-type']).toBe('image/png');
  });
});
