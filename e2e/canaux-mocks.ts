import type { Page } from '@playwright/test';
import {
  NOTIFICATION_PREFERENCES_PATH,
  type NotificationPreferences,
  type NotificationPreferencesView,
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_CHECK_PATH,
  PUSH_SUBSCRIPTION_PATH,
  PUSH_TEST_PATH,
  SMTP_SETTINGS_PATH,
  SMTP_TEST_PATH,
} from '@shared/notifications.ts';
import type { MaskedSetting, SettingInput } from '@shared/settings.ts';

// Faux courriel et push : réglage SMTP (propriétaire), préférences du membre, abonnements push ; écritures gardées.

export const DEVICE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/cet-appareil';

/** Réglage SMTP du faux serveur (`null` : jamais enregistré, 404). */
export async function mockSmtp(page: Page, initial: MaskedSetting<'smtp'> | null = null) {
  const state = {
    saved: initial,
    puts: [] as SettingInput<'smtp'>[],
    tests: [] as SettingInput<'smtp'>[],
    testReply: { status: 200, json: { ok: true } as object },
  };
  await page.route(`**${SMTP_TEST_PATH}`, (route) => {
    state.tests.push(route.request().postDataJSON());
    return route.fulfill(state.testReply);
  });
  await page.route(`**${SMTP_SETTINGS_PATH}`, (route) => {
    if (route.request().method() === 'GET')
      return state.saved
        ? route.fulfill({ json: state.saved })
        : route.fulfill({ status: 404, json: { error: 'Pas encore configuré' } });
    const body = route.request().postDataJSON() as SettingInput<'smtp'>;
    state.puts.push(body);
    const { password, ...rest } = body;
    state.saved = {
      enabled: true,
      port: 587,
      security: 'starttls',
      username: null,
      ...rest,
      password: { set: Boolean(password) || (state.saved?.password.set ?? false) },
    };
    return route.fulfill({ json: state.saved });
  });
  return state;
}

/**
 * Préférences du membre et push côté serveur (clé publique, abonnements, vérification, essai) ; `ownsDevice` : cet
 * appareil est déjà abonné pour le membre connecté (faux : pas abonné, ou abonné pour un autre membre).
 */
export async function mockPreferences(
  page: Page,
  initial: Partial<NotificationPreferencesView> = {},
  { ownsDevice = false } = {},
) {
  const state = {
    saved: {
      email: null,
      emailNotifications: true,
      pushNotifications: true,
      emailAvailable: false,
      pushDevices: 0,
      ...initial,
    } as NotificationPreferencesView,
    puts: [] as NotificationPreferences[],
    subscriptions: [] as Array<{ method: string; body: unknown }>,
    pushTests: 0,
    ownsDevice,
  };
  await page.route(`**${NOTIFICATION_PREFERENCES_PATH}`, (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as NotificationPreferences;
      state.puts.push(body);
      state.saved = { ...state.saved, ...body };
    }
    return route.fulfill({ json: state.saved });
  });
  await page.route(`**${PUSH_PUBLIC_KEY_PATH}`, (route) =>
    // Clé publique P-256 non compressée (65 octets) en base64url, comme celle de `web-push`.
    route.fulfill({ json: { publicKey: `B${'A'.repeat(86)}` } }),
  );
  await page.route(`**${PUSH_SUBSCRIPTION_PATH}`, (route) => {
    const method = route.request().method();
    state.subscriptions.push({ method, body: route.request().postDataJSON() });
    state.ownsDevice = method === 'PUT';
    state.saved = { ...state.saved, pushDevices: state.ownsDevice ? 1 : 0 };
    return route.fulfill({ status: 204 });
  });
  await page.route(`**${PUSH_SUBSCRIPTION_CHECK_PATH}`, (route) => {
    const { endpoint } = route.request().postDataJSON() as { endpoint: string };
    return route.fulfill({ json: { subscribed: state.ownsDevice && endpoint === DEVICE_ENDPOINT } });
  });
  await page.route(`**${PUSH_TEST_PATH}`, (route) => {
    state.pushTests++;
    return route.fulfill({ json: { reached: 1 } });
  });
  return state;
}

/**
 * Push simulé dans le navigateur (les e2e bloquent les vrais service workers) : `unsupported` retire `PushManager`,
 * sinon la permission de départ ; demander la permission l'accorde si elle n'est pas déjà refusée. `subscribed` : le
 * navigateur a déjà un abonnement (à qui il appartient, c'est le serveur qui le dit, `mockPreferences`).
 */
export async function stubBrowserPush(
  page: Page,
  permission: NotificationPermission | 'unsupported',
  { subscribed = false } = {},
) {
  await page.addInitScript(
    ({ permission, endpoint, subscribed }) => {
      if (permission === 'unsupported') {
        Reflect.deleteProperty(window, 'PushManager');
        return;
      }
      let current: NotificationPermission = permission;
      const fake = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'cle-appareil', auth: 'auth-appareil' } }),
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
      };
      let subscription: object | null = subscribed ? fake : null;
      const registration = {
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => {
            subscription = fake;
            return fake;
          },
        },
      };
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => current });
      Notification.requestPermission = async () => {
        if (current === 'default') current = 'granted';
        return current;
      };
      const container = {
        register: async () => registration,
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
      };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => container });
    },
    { permission, endpoint: DEVICE_ENDPOINT, subscribed },
  );
}
