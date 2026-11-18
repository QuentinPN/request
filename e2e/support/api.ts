import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page, type Route } from '@playwright/test';
import { API_KEYS_PATH, type ApiKey, type ApiKeyCreated, apiKeyPath } from '../../src/shared/api-keys.ts';
import {
  ARR_SERVERS_PATH,
  ARR_SERVERS_TEST_PATH,
  type ArrKind,
  type ArrServer,
  type ArrServerInput,
} from '../../src/shared/arr-servers.ts';
import { type Member, type MemberUpdate, memberUpdateSchema, userPath, type Viewer } from '../../src/shared/auth.ts';
import {
  BLOCKED_KEYWORDS_PATH,
  BLOCKED_TITLES_PATH,
  BLOCKLIST_PATH,
  type BlockedKeyword,
  type Blocklist,
  type BlockTitleInput,
  KEYWORD_SEARCH_PATH,
} from '../../src/shared/blocklist.ts';
import { DISCOVER_SETTINGS_PATH } from '../../src/shared/catalogue.ts';
import { WATCH_LINK_PATH, type WatchLink } from '../../src/shared/media-server.ts';
import type { NotificationPage } from '../../src/shared/notifications.ts';
import { capabilitiesOf, type Role } from '../../src/shared/roles.ts';
import { type MaskedSetting, type Setting, settingSchemas } from '../../src/shared/settings.ts';
import type { SettingSection, SetupState, TestResults } from '../../src/shared/setup.ts';
import {
  WEBHOOK_SERVER_QUERY,
  WEBHOOK_SETTINGS_PATH,
  WEBHOOK_TOKEN_PATH,
  WEBHOOK_TOKEN_QUERY,
  type WebhookSettings,
  webhookPath,
} from '../../src/shared/webhooks.ts';

// Faux serveur des tests du client : chaque `/api` est servi depuis un état en mémoire, typé par les contrats partagés.

export const viewerAs = (role: Role, name = 'Quentin'): Viewer => ({
  id: `id-${role}`,
  name,
  role,
  capabilities: capabilitiesOf(role),
  avatarUrl: null,
});

const allSaved = { mediaServer: true, tmdb: true, radarr: true, sonarr: true, rules: true };
export const completeSetup: SetupState = {
  services: allSaved,
  mediaServerKind: 'emby',
  hasOwner: true,
  hasMembers: true,
  complete: true,
};
export const freshSetup: SetupState = {
  services: { mediaServer: false, tmdb: false, radarr: false, sonarr: false, rules: false },
  mediaServerKind: null,
  hasOwner: false,
  hasMembers: false,
  complete: false,
};

export const embyTest: TestResults['mediaServer'] = {
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

/** Serveur Radarr/Sonarr enregistré, tel que le renvoie `/api/arr-servers` (clé masquée). */
export function arrServer(id: number, type: ArrKind, patch: Partial<ArrServer> = {}): ArrServer {
  return {
    id,
    type,
    name: type === 'radarr' ? 'Radarr' : 'Sonarr',
    url: type === 'radarr' ? 'http://192.0.2.20:7878' : 'http://192.0.2.20:8989',
    apiKey: { set: true },
    is4k: false,
    isDefault: true,
    qualityProfileId: 4,
    rootFolderPath: type === 'radarr' ? '/films' : '/series',
    minimumAvailability: type === 'radarr' ? 'released' : null,
    seriesType: type === 'sonarr' ? 'standard' : null,
    languageProfileId: null,
    tags: [],
    ...patch,
  };
}

/** Un Radarr et un Sonarr, comme après l'assistant. */
export const defaultArrServers = (): ArrServer[] => [arrServer(1, 'radarr'), arrServer(2, 'sonarr')];

/** Réglages des webhooks pour un jeton donné, comme les bâtit le serveur (`routes/webhooks.ts`) : une adresse par serveur. */
export const webhookSettingsOf = (token: string, servers = defaultArrServers()): WebhookSettings => ({
  token,
  servers: servers.map(({ id, name, type, is4k }) => ({
    id,
    name,
    type,
    is4k,
    url: `http://localhost:3100${webhookPath(type)}?${WEBHOOK_TOKEN_QUERY}=${token}&${WEBHOOK_SERVER_QUERY}=${id}`,
  })),
});

/** Adresse du webhook d'un serveur, par son nom. */
export const webhookUrl = (settings: WebhookSettings, name: string) =>
  settings.servers.find((s) => s.name === name)?.url ?? '';

type MockState = {
  setup: SetupState;
  viewer: Viewer | null;
  settings: { [K in SettingSection]?: MaskedSetting<K> };
  /** Serveurs Radarr/Sonarr ; ajouts, modifications et suppressions s'y appliquent (sans test de connexion). */
  arrServers: ArrServer[];
  /** Type et id du serveur multimédia, adresse publique : `null` tant qu'aucun lien n'est possible. */
  embyLink: WatchLink | null;
  webhooks: WebhookSettings;
  /** Clés d'API (Réglages › API), vide par défaut ; la création en ajoute une, la révocation la marque révoquée. */
  apiKeys: ApiKey[];
  /** Membres (`/api/users`) : sélecteur de la feuille de demande pour autrui. */
  members: Member[];
  /** Ids des membres déconnectés partout (Réglages › Membres : `DELETE /api/users/:id/sessions`). */
  signedOut: string[];
  /** Modifications de rôle et de quotas reçues (Réglages › Membres : `PUT /api/users/:id`) ; elles s'appliquent à `members`. */
  memberUpdates: { id: string; body: MemberUpdate }[];
  /** Titres et mots-clés bloqués (Réglages › Blocages) ; blocage, déblocage et mots-clés s'y appliquent. */
  blocklist: Blocklist;
  /** Mots-clés TMDB que trouve la recherche (filtrés par nom). */
  keywordResults: BlockedKeyword[];
  /** Réglage « Masquer dans Découvrir ». */
  discover: Setting<'discover'>;
};

/** Secret renvoyé par la création factice d'une clé d'API. */
export const API_KEY_SECRET = 'ur_Zk3pQ9vXw2LrT7nMb4YcA8dEfGhJ1sUo5iVxN6qWtPe';

const json = (route: Route, status: number, body?: unknown) =>
  status === 204 ? route.fulfill({ status }) : route.fulfill({ status, json: body });

export class ApiMock {
  state: MockState = {
    setup: completeSetup,
    viewer: viewerAs('owner'),
    settings: {},
    arrServers: defaultArrServers(),
    embyLink: null,
    webhooks: webhookSettingsOf('jeton-initial'),
    apiKeys: [],
    members: [],
    signedOut: [],
    memberUpdates: [],
    blocklist: { titles: [], keywords: [] },
    keywordResults: [],
    discover: { hideAvailable: false, hideRequested: false },
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
    if (method === 'GET' && pathname === WATCH_LINK_PATH) return json(route, 200, { link: state.embyLink });
    if (method === 'GET' && pathname === WEBHOOK_SETTINGS_PATH) return json(route, 200, state.webhooks);
    if (method === 'POST' && pathname === WEBHOOK_TOKEN_PATH) {
      state.webhooks = webhookSettingsOf('jeton-regenere');
      return json(route, 200, state.webhooks);
    }
    if (pathname.startsWith(ARR_SERVERS_PATH)) return this.arrServers(route, method, pathname);
    if (method === 'GET' && pathname === API_KEYS_PATH) return json(route, 200, state.apiKeys);
    if (method === 'POST' && pathname === API_KEYS_PATH) {
      const { name } = route.request().postDataJSON() as { name: string };
      const apiKey: ApiKey = {
        id: state.apiKeys.length + 1,
        name,
        prefix: API_KEY_SECRET.slice(0, 8),
        createdByName: state.viewer?.name ?? 'Quentin',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      state.apiKeys.unshift(apiKey);
      return json(route, 201, { apiKey, secret: API_KEY_SECRET } satisfies ApiKeyCreated);
    }
    const revoked = state.apiKeys.find((key) => apiKeyPath(key.id) === pathname);
    if (method === 'DELETE' && revoked) {
      revoked.revokedAt = new Date().toISOString();
      return json(route, 204);
    }
    if (method === 'GET' && pathname === '/api/users') return json(route, 200, state.members);
    const edited = state.members.find((m) => userPath(m.id) === decodeURIComponent(pathname));
    if (method === 'PUT' && edited) {
      const body = memberUpdateSchema.parse(route.request().postDataJSON());
      state.memberUpdates.push({ id: edited.id, body });
      if (body.role !== undefined) edited.role = body.role;
      if (body.quotaOverride !== undefined) edited.quotaOverride = body.quotaOverride;
      return json(route, 200, edited);
    }
    const signedOut = state.members.find((m) => userPath(m.id, 'sessions') === pathname);
    if (method === 'DELETE' && signedOut) {
      state.signedOut.push(signedOut.id);
      return json(route, 204);
    }
    if (pathname.startsWith(BLOCKLIST_PATH)) return this.blocklist(route, method, pathname);
    if (pathname === DISCOVER_SETTINGS_PATH) {
      if (method === 'PUT') state.discover = route.request().postDataJSON() as Setting<'discover'>;
      return json(route, 200, state.discover);
    }
    const setting = pathname.match(/^\/api\/settings\/(\w+)$/)?.[1] as SettingSection | undefined;
    if (method === 'GET' && setting) {
      const value = state.settings[setting] ?? (setting === 'rules' ? settingSchemas.rules.parse({}) : undefined);
      return value ? json(route, 200, value) : json(route, 404, { error: 'Pas encore configuré' });
    }
    return json(route, 404, { error: 'Introuvable' });
  }

  /** `/api/blocklist` : titres (blocage nommé « Titre <id> » sauf s'il est déjà connu), mots-clés et leur recherche. */
  private blocklist(route: Route, method: string, pathname: string) {
    const { state } = this;
    const list = state.blocklist;
    if (method === 'GET' && pathname === BLOCKLIST_PATH) return json(route, 200, list);
    if (method === 'GET' && pathname === KEYWORD_SEARCH_PATH) {
      const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
      return json(
        route,
        200,
        state.keywordResults.filter((k) => k.name.toLowerCase().includes(q)),
      );
    }
    if (method === 'PUT' && pathname === BLOCKED_KEYWORDS_PATH) {
      list.keywords = (route.request().postDataJSON() as { keywords: BlockedKeyword[] }).keywords;
      return json(route, 200, list);
    }
    if (method === 'POST' && pathname === BLOCKED_TITLES_PATH) {
      const { mediaType, tmdbId } = route.request().postDataJSON() as BlockTitleInput;
      list.titles.unshift({
        mediaType,
        tmdbId,
        title: `Titre ${tmdbId}`,
        blockedBy: state.viewer?.name ?? null,
        createdAt: new Date().toISOString(),
      });
      return json(route, 200, list);
    }
    const [, type, id] = pathname.match(/\/titles\/(movie|tv)\/(\d+)$/) ?? [];
    if (method === 'DELETE' && type) {
      list.titles = list.titles.filter((t) => !(t.mediaType === type && t.tmdbId === Number(id)));
      return json(route, 200, list);
    }
    return json(route, 404, { error: 'Introuvable' });
  }

  /** `/api/arr-servers` : un seul serveur par défaut par couple (type, 4K), comme le serveur. Le test répond `sonarrTest`. */
  private arrServers(route: Route, method: string, pathname: string) {
    const { state } = this;
    if (method === 'GET' && pathname === ARR_SERVERS_PATH) return json(route, 200, state.arrServers);
    if (method === 'POST' && pathname === ARR_SERVERS_TEST_PATH) return json(route, 200, sonarrTest);
    const id = Number(pathname.match(/\/(\d+)$/)?.[1]);
    if (method === 'DELETE') {
      state.arrServers = state.arrServers.filter((s) => s.id !== id);
      return json(route, 204);
    }
    if (method === 'POST' || method === 'PUT') {
      const { apiKey: _key, ...input } = route.request().postDataJSON() as ArrServerInput;
      const saved = arrServer(
        method === 'POST' ? Math.max(0, ...state.arrServers.map((s) => s.id)) + 1 : id,
        input.type,
        {
          ...input,
          is4k: input.is4k ?? false,
          isDefault: input.isDefault ?? false,
        } as Partial<ArrServer>,
      );
      const samePair = (s: ArrServer) => s.type === saved.type && s.is4k === saved.is4k && s.id !== saved.id;
      if (saved.isDefault) for (const s of state.arrServers.filter(samePair)) s.isDefault = false;
      else if (!state.arrServers.some((s) => samePair(s) && s.isDefault)) saved.isDefault = true;
      state.arrServers =
        method === 'POST' ? [...state.arrServers, saved] : state.arrServers.map((s) => (s.id === id ? saved : s));
      return json(route, method === 'POST' ? 201 : 200, saved);
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

/** Jeton d'installation saisi dans l'assistant d'une installation neuve (envoyé en `X-Setup-Token`). */
export const SETUP_TOKEN = 'jeton-installation-e2e';
export const fillSetupToken = (page: Page) => field(page, 'Jeton d’installation').fill(SETUP_TOKEN);

export async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
}
