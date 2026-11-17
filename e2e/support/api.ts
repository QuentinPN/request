import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import type { Viewer } from '../../src/shared/auth.ts';
import { EMBY_LINK_PATH, type EmbyLink } from '../../src/shared/emby.ts';
import type { NotificationPage } from '../../src/shared/notifications.ts';
import { capabilitiesOf, type Role } from '../../src/shared/roles.ts';
import { type MaskedSetting, settingSchemas } from '../../src/shared/settings.ts';
import type { SetupSection, SetupState, TestResults } from '../../src/shared/setup.ts';
import {
  WEBHOOK_SETTINGS_PATH,
  WEBHOOK_TOKEN_PATH,
  WEBHOOK_TOKEN_QUERY,
  type WebhookSettings,
  webhookPath,
  webhookServices,
} from '../../src/shared/webhooks.ts';

// Faux serveur des tests du client : chaque `/api` est servi depuis un état en mémoire, typé par les contrats partagés.

export const viewerAs = (role: Role, name = 'Quentin'): Viewer => ({
  id: `id-${role}`,
  name,
  role,
  capabilities: capabilitiesOf(role),
  avatarUrl: null,
});

const allSaved = { emby: true, tmdb: true, radarr: true, sonarr: true, rules: true };
export const completeSetup: SetupState = { services: allSaved, hasOwner: true, complete: true };
export const freshSetup: SetupState = {
  services: { emby: false, tmdb: false, radarr: false, sonarr: false, rules: false },
  hasOwner: false,
  complete: false,
};

export const embyTest: TestResults['emby'] = {
  serverName: 'Salon',
  version: '4.9.1',
  serverId: 'srv',
  libraries: [
    { id: 'lib-films', name: 'Films', type: 'movies' },
    { id: 'lib-series', name: 'Séries', type: 'tvshows' },
    { id: 'lib-musique', name: 'Musique', type: 'other' },
  ],
};

export const sonarrTest: TestResults['sonarr'] = {
  version: '4.0.11',
  qualityProfiles: [
    { id: 4, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' },
    { id: 6, name: 'Any' },
  ],
  rootFolders: [
    { id: 1, path: '/series', freeSpace: 1.2 * 1024 ** 4 },
    { id: 2, path: '/anime', freeSpace: 640 * 1024 ** 3 },
  ],
};

/** Réglages des webhooks pour un jeton donné, comme les bâtit le serveur (`routes/webhooks.ts`). */
export const webhookSettingsOf = (token: string): WebhookSettings => ({
  token,
  urls: Object.fromEntries(
    webhookServices.map((s) => [s, `http://localhost:3100${webhookPath(s)}?${WEBHOOK_TOKEN_QUERY}=${token}`]),
  ) as WebhookSettings['urls'],
});

type MockState = {
  setup: SetupState;
  viewer: Viewer | null;
  settings: { [K in SetupSection]?: MaskedSetting<K> };
  /** Adresse publique d'Emby et id du serveur : `null` tant qu'aucune adresse publique n'est réglée. */
  embyLink: EmbyLink | null;
  webhooks: WebhookSettings;
};

const json = (route: Route, status: number, body?: unknown) =>
  status === 204 ? route.fulfill({ status }) : route.fulfill({ status, json: body });

export class ApiMock {
  state: MockState = {
    setup: completeSetup,
    viewer: viewerAs('owner'),
    settings: {},
    embyLink: null,
    webhooks: webhookSettingsOf('jeton-initial'),
  };

  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Routes de base ; un test en ajoute d'autres avec `page.route` (la dernière déclarée répond d'abord). */
  async install() {
    await this.page.route('**/api/**', (route) => this.handle(route));
  }

  private handle(route: Route) {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const { state } = this;
    if (method === 'GET' && pathname === '/api/setup/state') return json(route, 200, state.setup);
    if (method === 'GET' && pathname === '/api/auth/me')
      return state.viewer
        ? json(route, 200, { viewer: state.viewer })
        : json(route, 401, { error: 'Connexion requise' });
    if (method === 'POST' && pathname === '/api/auth/logout') {
      state.viewer = null;
      return json(route, 204);
    }
    // Aucune notification par défaut (e2e/notifications.spec.ts en sert d'autres).
    if (method === 'GET' && pathname === '/api/notifications')
      return json(route, 200, { page: 1, totalPages: 0, unread: 0, results: [] } satisfies NotificationPage);
    if (method === 'GET' && pathname === EMBY_LINK_PATH) return json(route, 200, { link: state.embyLink });
    if (method === 'GET' && pathname === WEBHOOK_SETTINGS_PATH) return json(route, 200, state.webhooks);
    if (method === 'POST' && pathname === WEBHOOK_TOKEN_PATH) {
      state.webhooks = webhookSettingsOf('jeton-regenere');
      return json(route, 200, state.webhooks);
    }
    const setting = pathname.match(/^\/api\/settings\/(\w+)$/)?.[1] as SetupSection | undefined;
    if (method === 'GET' && setting) {
      const value = state.settings[setting] ?? (setting === 'rules' ? settingSchemas.rules.parse({}) : undefined);
      return value ? json(route, 200, value) : json(route, 404, { error: 'Pas encore configuré' });
    }
    return json(route, 404, { error: 'Introuvable' });
  }
}

export const test = base.extend<{ api: ApiMock }>({
  api: [
    async ({ page }, use) => {
      // Sans animation : axe et les assertions ne voient jamais un élément à moitié opaque.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const api = new ApiMock(page);
      await api.install();
      await use(api);
    },
    { auto: true },
  ],
});

export { expect };

/** Champ visible par son libellé exact (les sections repliées gardent leurs champs, masqués). */
export const field = (page: Page, label: string) => page.getByLabel(label, { exact: true }).filter({ visible: true });

export async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
}
