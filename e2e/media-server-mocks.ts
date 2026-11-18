import type { BrowserContext, Page } from '@playwright/test';
import {
  PLEX_PIN_CHECK_PATH,
  PLEX_PIN_PATH,
  type PlexPinCreated,
  type PlexPinState,
} from '../src/shared/media-server.ts';
import type { MediaServerKind } from '../src/shared/settings.ts';
import type { TestResults } from '../src/shared/setup.ts';
import { type ApiMock, embyTest, freshSetup, viewerAs } from './support/api.ts';

// Serveur multimédia Emby, Jellyfin ou Plex (7.3) : installation d'un type donné, plex.tv simulé.

export const PLEX_AUTH_URL =
  'https://app.plex.tv/auth/#!?clientID=client&code=CODE-PIN&context%5Bdevice%5D%5Bproduct%5D=Request';

export const plexTest: TestResults['mediaServer'] = { ...embyTest, serverName: 'Salon', version: '1.41.3' };

/** Installation dont le serveur multimédia est de ce type, propriétaire inscrit, personne de connecté. */
export function signedOutWith(api: ApiMock, kind: MediaServerKind) {
  const setup = structuredClone(freshSetup);
  setup.services.mediaServer = true;
  api.state.setup = { ...setup, mediaServerKind: kind, hasOwner: true, hasMembers: true };
  api.state.viewer = null;
}

/**
 * plex.tv simulé : le code PIN de l'API (création, puis `pending` jusqu'à `grant()`), et la fenêtre app.plex.tv servie
 * par une page locale (jamais le vrai site). `refusal` : réponse de l'échange une fois le code validé.
 */
export async function mockPlexPin(page: Page, context: BrowserContext, api: ApiMock, refusal?: string) {
  await context.route('https://app.plex.tv/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Plex</title><h1>Connexion Plex</h1>' }),
  );
  const pin = { granted: false, polls: 0 };
  await page.route(`**${PLEX_PIN_PATH}`, (route) =>
    route.fulfill({
      json: {
        authUrl: PLEX_AUTH_URL,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      } satisfies PlexPinCreated,
    }),
  );
  await page.route(`**${PLEX_PIN_CHECK_PATH}`, (route) => {
    pin.polls += 1;
    if (!pin.granted) return route.fulfill({ json: { status: 'pending' } satisfies PlexPinState });
    if (refusal) return route.fulfill({ status: 403, json: { error: refusal } });
    const viewer = viewerAs('member', 'Amie');
    api.state.viewer = viewer;
    return route.fulfill({ json: { status: 'authorized', viewer } satisfies PlexPinState });
  });
  return {
    pin,
    grant: () => {
      pin.granted = true;
    },
  };
}
