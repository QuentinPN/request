import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebPushError } from 'web-push';
import { buildApp } from '../src/server/app.ts';
import { openDataDir } from '../src/server/db/index.ts';
import { media, pushSubscriptions, settings, users } from '../src/server/db/schema.ts';
import type { MailMessage, MailTransport } from '../src/server/services/email.ts';
import { notify } from '../src/server/services/notifications.ts';
import type { PushSender } from '../src/server/services/push.ts';
import { getSetting, setSetting } from '../src/server/services/settings.ts';
import {
  NOTIFICATION_PREFERENCES_PATH,
  type NotificationPreferencesView,
  PUSH_ENDPOINT_MAX,
  PUSH_KEY_MAX,
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_CHECK_PATH,
  PUSH_SUBSCRIPTION_PATH,
  PUSH_TEST_PATH,
  type PushSubscriptionCheck,
  type PushSubscriptionInput,
} from '../src/shared/notifications.ts';
import type { Role } from '../src/shared/roles.ts';
import type { SettingInput } from '../src/shared/settings.ts';
import { loginAs, trackFakeServers, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const startServer = trackFakeServers();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PUBLIC_URL = 'https://demandes.exemple.fr';
const SMTP: SettingInput<'smtp'> = {
  host: 'smtp.exemple.fr',
  port: 587,
  security: 'starttls',
  username: 'appli',
  password: 'mot-de-passe-smtp',
  from: 'Request <appli@exemple.fr>',
};

const matrix = {
  id: 603,
  title: 'Matrix <1999>',
  release_date: '1999-03-30',
  overview: 'Un pirate découvre la vérité.',
  poster_path: '/matrix.jpg',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
};

const device = (n: number): PushSubscriptionInput => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/abonnement-${n}`,
  keys: { p256dh: `cle-${n}`, auth: `auth-${n}` },
});

interface SentMail extends MailMessage {
  password: string | null;
  host: string;
}

/** Appli branchée sur de faux TMDB, SMTP et service push ; SMTP réglé si `smtp` est fourni. */
async function setup(options: { smtp?: Partial<SettingInput<'smtp'>> } = {}) {
  const tmdb = await startServer({ 'GET /movie/603': matrix });
  const mails: SentMail[] = [];
  const mail = { fail: null as string | null };
  const mailTransport: MailTransport = (config) => ({
    sendMail: async (message) => {
      if (mail.fail) throw Object.assign(new Error('refus SMTP'), { code: mail.fail });
      mails.push({ ...message, password: config.password, host: config.host });
    },
  });
  const pushes: Array<{ endpoint: string; payload: unknown; subject: string | undefined }> = [];
  /** Statut de refus par adresse d'abonnement (404, 410, 500…). */
  const pushReplies = new Map<string, number>();
  const pushSender: PushSender = async (subscription, payload, opts) => {
    const code = pushReplies.get(subscription.endpoint);
    if (code) throw new WebPushError('refus', code, {}, '', subscription.endpoint);
    pushes.push({
      endpoint: subscription.endpoint,
      payload: JSON.parse(String(payload)),
      subject: opts?.vapidDetails?.subject,
    });
    return { statusCode: 201, body: '', headers: {} };
  };
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: 'abcdef0123456789abcdef0123456789' });
  if (options.smtp) setSetting(data.db, data.cryptoKey, 'smtp', { ...SMTP, ...options.smtp });
  const app = await buildApp({
    data,
    upstreams: { tmdbUrl: tmdb.url, mailTransport, pushSender },
    publicUrl: PUBLIC_URL,
  });
  cleanups.push(() => app.close());

  const as = async (role: Role, id?: string) => {
    const { user, headers } = await loginAs(app, role, id);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload && { payload }) });
    return {
      user,
      get: (url: string) => call('GET', url),
      post: (url: string, payload?: object) => call('POST', url, payload),
      put: (url: string, payload: object) => call('PUT', url, payload),
      delete: (url: string, payload: object) => call('DELETE', url, payload),
      /** Adresse et préférences, puis appareils abonnés. */
      async prefer(prefs: { email?: string | null; emailNotifications?: boolean; pushNotifications?: boolean }) {
        const response = await call('PUT', NOTIFICATION_PREFERENCES_PATH, {
          email: null,
          emailNotifications: true,
          pushNotifications: true,
          ...prefs,
        });
        expect(response.statusCode).toBe(200);
      },
      subscribe: async (n: number) =>
        expect((await call('PUT', PUSH_SUBSCRIPTION_PATH, device(n))).statusCode).toBe(204),
    };
  };
  /** Envois terminés : courriels et push reçus. */
  const sent = async () => {
    await app.afterCommit.idle();
    return { mails, pushes };
  };
  return { app, data, tmdb, as, sent, mail, pushReplies };
}

type Actor = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['as']>>;
const requestMovie = (member: Actor) => member.post('/api/requests', { type: 'movie', tmdbId: 603 });

describe('distribution des notifications', () => {
  it('une notification part par courriel et en push, à chacun selon ses préférences', async () => {
    const { as, sent } = await setup({ smtp: {} });
    const member = await as('member');
    const manager = await as('manager');
    await manager.prefer({ email: 'gestion@exemple.fr' });
    await manager.subscribe(1);
    const owner = await as('owner');
    await owner.prefer({ email: 'proprio@exemple.fr', emailNotifications: false });
    await owner.subscribe(2);
    const other = await as('manager', 'gestionnaire-sans-push');
    await other.prefer({ email: 'autre@exemple.fr', pushNotifications: false });
    await other.subscribe(3);

    expect((await requestMovie(member)).statusCode).toBe(201);
    const { mails, pushes } = await sent();

    expect(mails.map((m) => m.to).sort()).toEqual(['autre@exemple.fr', 'gestion@exemple.fr']);
    const mail = mails.find((m) => m.to === 'gestion@exemple.fr');
    expect(mail).toMatchObject({
      from: 'Request <appli@exemple.fr>',
      subject: 'Nouvelle demande à approuver',
      password: 'mot-de-passe-smtp',
    });
    expect(mail?.text).toContain(`${member.user.name} a demandé « Matrix <1999> ».`);
    expect(mail?.text).toContain(`${PUBLIC_URL}/approbations`);
    // Le titre TMDB est échappé dans le HTML.
    expect(mail?.html).toContain('« Matrix &lt;1999&gt; »');
    expect(mail?.html).not.toContain('<1999>');

    expect(pushes.map((p) => p.endpoint).sort()).toEqual([device(1).endpoint, device(2).endpoint]);
    expect(pushes[0]).toMatchObject({
      payload: {
        title: 'Nouvelle demande à approuver',
        body: `${member.user.name} a demandé « Matrix <1999> ».`,
        url: '/approbations',
      },
      subject: PUBLIC_URL,
    });
  });

  it('sans SMTP réglé (ou désactivé), sans adresse ni appareil : rien ne part, pas même vers TMDB', async () => {
    for (const smtp of [undefined, { enabled: false }]) {
      const { as, sent, tmdb } = await setup(smtp ? { smtp } : {});
      const member = await as('member');
      const manager = await as('manager');
      await manager.prefer({ email: 'gestion@exemple.fr', pushNotifications: true });
      await requestMovie(member);
      const before = tmdb.requests.length;
      expect(await sent()).toEqual({ mails: [], pushes: [] });
      expect(tmdb.requests.length).toBe(before);
    }
  });

  it('transaction annulée : ni courriel ni push', async () => {
    const { as, sent, data } = await setup({ smtp: {} });
    const member = await as('member');
    await member.prefer({ email: 'membre@exemple.fr' });
    await member.subscribe(1);
    expect(() =>
      data.db.transaction((tx) => {
        notify(tx, {
          kind: 'issue_resolved',
          recipients: [member.user.id],
          actorId: null,
          detail: null,
          at: new Date(),
        });
        throw new Error('annulée');
      }),
    ).toThrow('annulée');
    expect(await sent()).toEqual({ mails: [], pushes: [] });
  });

  it('les signalements passent par `notify` : courriel et push, lien vers le signalement', async () => {
    const { as, sent, data } = await setup({ smtp: {} });
    data.db
      .insert(media)
      .values({ type: 'movie', tmdbId: 603, status: 'available', statusUpdatedAt: new Date() })
      .run();
    const member = await as('member');
    const manager = await as('manager');
    await manager.prefer({ email: 'gestion@exemple.fr' });
    await manager.subscribe(1);
    const created = await member.post('/api/issues', {
      type: 'subtitles',
      mediaType: 'movie',
      tmdbId: 603,
      message: 'Les sous-titres sont décalés',
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: number }>();

    const { mails, pushes } = await sent();
    expect(mails).toMatchObject([{ to: 'gestion@exemple.fr', subject: 'Nouveau signalement' }]);
    expect(mails[0]?.text).toContain(`${PUBLIC_URL}/signalements?id=${id}`);
    expect(pushes).toMatchObject([
      {
        endpoint: device(1).endpoint,
        payload: { title: 'Nouveau signalement', url: `/signalements?id=${id}` },
      },
    ]);
  });

  it('l’échec d’un canal n’empêche ni les autres ni l’action du membre ; journalisé sans adresse', async () => {
    const { app, as, sent, mail, pushReplies } = await setup({ smtp: {} });
    mail.fail = 'ECONNECTION';
    const member = await as('member');
    const manager = await as('manager');
    await manager.prefer({ email: 'gestion@exemple.fr' });
    await manager.subscribe(1);
    await manager.subscribe(2);
    pushReplies.set(device(2).endpoint, 500);

    expect((await requestMovie(member)).statusCode).toBe(201);
    const { mails, pushes } = await sent();
    expect(mails).toEqual([]);
    // L'appareil 1 reçoit malgré le refus de l'appareil 2 et l'échec du courriel ; aucune nouvelle tentative.
    expect(pushes.map((p) => p.endpoint)).toEqual([device(1).endpoint]);
    // Journaux (et donc la sortie standard du serveur) : les plus récentes d'abord.
    const { entries } = app.logs.list({ level: 'error', q: '', limit: 10 });
    expect(entries.map((e) => [e.message, e.context])).toEqual([
      ['Notification push non envoyée', '{"detail":"HTTP 500"}'],
      ['Notification courriel non envoyée', '{"detail":"ECONNECTION"}'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('exemple.fr');
  });

  it('push : un appareil disparu (404, 410) est désabonné, les autres reçoivent', async () => {
    const { as, sent, data, pushReplies } = await setup();
    const member = await as('member');
    const manager = await as('manager');
    for (const n of [1, 2, 3]) await manager.subscribe(n);
    pushReplies.set(device(2).endpoint, 410);
    pushReplies.set(device(3).endpoint, 404);
    await requestMovie(member);
    expect((await sent()).pushes.map((p) => p.endpoint)).toEqual([device(1).endpoint]);
    const left = data.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions).all();
    expect(left).toEqual([{ endpoint: device(1).endpoint }]);
  });
});

describe('préférences du membre (Compte)', () => {
  it('par défaut : pas d’adresse, courriel et push activés, aucun appareil', async () => {
    const { as } = await setup();
    const response = await (await as('member')).get(NOTIFICATION_PREFERENCES_PATH);
    expect(response.json()).toEqual<NotificationPreferencesView>({
      email: null,
      emailNotifications: true,
      pushNotifications: true,
      emailAvailable: false,
      pushDevices: 0,
    });
  });

  it('adresse validée, enregistrée pour soi seulement', async () => {
    const { as, data } = await setup({ smtp: {} });
    const member = await as('member');
    const invalid = await member.put(NOTIFICATION_PREFERENCES_PATH, {
      email: 'pas-une-adresse',
      emailNotifications: true,
      pushNotifications: true,
    });
    expect(invalid.statusCode).toBe(400);
    await member.subscribe(1);
    const saved = await member.put(NOTIFICATION_PREFERENCES_PATH, {
      email: 'membre@exemple.fr',
      emailNotifications: false,
      pushNotifications: true,
    });
    expect(saved.json()).toEqual({
      email: 'membre@exemple.fr',
      emailNotifications: false,
      pushNotifications: true,
      emailAvailable: true,
      pushDevices: 1,
    });
    const row = data.db.select().from(users).where(eq(users.id, member.user.id)).get();
    expect(row).toMatchObject({ email: 'membre@exemple.fr', emailNotifications: false });
  });

  it('connexion requise', async () => {
    const { app } = await setup();
    await app.ready();
    expect((await app.inject({ method: 'GET', url: NOTIFICATION_PREFERENCES_PATH })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: PUSH_PUBLIC_KEY_PATH })).statusCode).toBe(401);
  });
});

describe('abonnements push', () => {
  it('clé publique VAPID créée au premier besoin, stable, privée chiffrée en base', async () => {
    const { as, data } = await setup();
    const member = await as('member');
    expect(getSetting(data.db, data.cryptoKey, 'vapid')).toBeNull();
    const { publicKey } = (await member.get(PUSH_PUBLIC_KEY_PATH)).json<{ publicKey: string }>();
    expect(publicKey).toMatch(/^[\w-]{80,}$/);
    expect((await member.get(PUSH_PUBLIC_KEY_PATH)).json()).toEqual({ publicKey });
    const vapid = getSetting(data.db, data.cryptoKey, 'vapid');
    const raw = data.db.select().from(settings).where(eq(settings.key, 'vapid')).get()?.value ?? '';
    expect(vapid?.publicKey).toBe(publicKey);
    expect(raw).not.toContain(vapid?.privateKey);
  });

  it('un appareil par adresse : réabonné, il passe au membre connecté ; on ne désabonne que les siens', async () => {
    const { as, data } = await setup();
    const alice = await as('member', 'alice');
    const bob = await as('member', 'bob');
    await alice.subscribe(1);
    await bob.subscribe(1);
    const rows = () => data.db.select({ userId: pushSubscriptions.userId }).from(pushSubscriptions).all();
    expect(rows()).toEqual([{ userId: bob.user.id }]);

    expect((await alice.delete(PUSH_SUBSCRIPTION_PATH, { endpoint: device(1).endpoint })).statusCode).toBe(204);
    expect(rows()).toHaveLength(1);
    expect((await bob.delete(PUSH_SUBSCRIPTION_PATH, { endpoint: device(1).endpoint })).statusCode).toBe(204);
    expect(rows()).toEqual([]);
  });

  it('appareil partagé : « activé » seulement pour le membre à qui l’appareil est abonné', async () => {
    const { as } = await setup();
    const alice = await as('member', 'alice');
    const bob = await as('member', 'bob');
    const check = async (actor: Actor) =>
      (await actor.post(PUSH_SUBSCRIPTION_CHECK_PATH, { endpoint: device(1).endpoint })).json<PushSubscriptionCheck>();

    expect(await check(alice)).toEqual({ subscribed: false });
    await alice.subscribe(1);
    expect(await check(alice)).toEqual({ subscribed: true });
    expect(await check(bob)).toEqual({ subscribed: false });
    // Bob active le push sur le même navigateur : l'appareil lui est réattribué.
    await bob.subscribe(1);
    expect(await check(bob)).toEqual({ subscribed: true });
    expect(await check(alice)).toEqual({ subscribed: false });
    expect((await alice.post(PUSH_SUBSCRIPTION_CHECK_PATH, { endpoint: 'pas-une-adresse' })).statusCode).toBe(400);
  });

  it('abonnement invalide refusé (adresse non HTTPS, clés manquantes)', async () => {
    const { as } = await setup();
    const member = await as('member');
    expect(
      (await member.put(PUSH_SUBSCRIPTION_PATH, { ...device(1), endpoint: 'http://fcm.googleapis.com/fcm/send/x' }))
        .statusCode,
    ).toBe(400);
    expect((await member.put(PUSH_SUBSCRIPTION_PATH, { endpoint: device(1).endpoint })).statusCode).toBe(400);
    // Longueurs plafonnées : endpoint, clés.
    const long = { ...device(1), endpoint: `${device(1).endpoint}/${'x'.repeat(PUSH_ENDPOINT_MAX)}` };
    expect((await member.put(PUSH_SUBSCRIPTION_PATH, long)).statusCode).toBe(400);
    for (const key of ['p256dh', 'auth'] as const) {
      const keys = { ...device(1).keys, [key]: 'k'.repeat(PUSH_KEY_MAX + 1) };
      expect((await member.put(PUSH_SUBSCRIPTION_PATH, { ...device(1), keys })).statusCode).toBe(400);
    }
  });

  it('SSRF : seuls les services push connus sont acceptés, jamais une adresse interne', async () => {
    const { as, data } = await setup();
    const member = await as('member');
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://192.0.2.10/push',
      'https://localhost/push',
      'https://emby.maison.lan/push',
      'https://fcm.googleapis.com.piege.fr/push',
      'https://googleapis.com/push',
      'https://fcm.googleapis.com:8443/push',
    ]) {
      const response = await member.put(PUSH_SUBSCRIPTION_PATH, { ...device(1), endpoint });
      expect(response.statusCode, endpoint).toBe(400);
    }
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ])
      expect((await member.put(PUSH_SUBSCRIPTION_PATH, { ...device(1), endpoint })).statusCode, endpoint).toBe(204);
    expect(data.db.select().from(pushSubscriptions).all()).toHaveLength(4);
  });

  it('SSRF : un abonnement enregistré hors des services connus n’est jamais contacté, il est supprimé', async () => {
    const { as, sent, data } = await setup();
    const member = await as('member');
    await member.subscribe(1);
    const now = new Date();
    data.db
      .insert(pushSubscriptions)
      .values({
        userId: member.user.id,
        endpoint: 'https://192.0.2.10/interne',
        p256dh: 'cle',
        auth: 'auth',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect((await member.post(PUSH_TEST_PATH)).json()).toEqual({ reached: 1 });
    expect((await sent()).pushes.map((p) => p.endpoint)).toEqual([device(1).endpoint]);
    const left = data.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions).all();
    expect(left).toEqual([{ endpoint: device(1).endpoint }]);
  });

  it('essai : vers ses appareils seulement, 409 sans appareil, 422 si le service refuse', async () => {
    const { as, sent, pushReplies } = await setup();
    const member = await as('member');
    expect((await member.post(PUSH_TEST_PATH)).statusCode).toBe(409);
    await member.subscribe(1);
    await (await as('member', 'autre')).subscribe(2);
    const ok = await member.post(PUSH_TEST_PATH);
    expect(ok.json()).toEqual({ reached: 1 });
    expect((await sent()).pushes).toMatchObject([
      { endpoint: device(1).endpoint, payload: { title: 'Essai de Request', url: '/compte' } },
    ]);
    pushReplies.set(device(1).endpoint, 500);
    expect((await member.post(PUSH_TEST_PATH)).statusCode).toBe(422);
  });
});
