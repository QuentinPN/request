import type { Page } from '@playwright/test';
import { mockPlexPin, PLEX_AUTH_URL, plexTest, signedOutWith } from './media-server-mocks.ts';
import { expect, expectNoAxeViolations, field, freshSetup, test } from './support/api.ts';

// Serveur multimédia Emby, Jellyfin ou Plex (7.3) : choix du type dans l'assistant, connexion par code PIN Plex.

test('Plex : le bouton ouvre app.plex.tv, attend la validation, puis connecte le membre', async ({
  page,
  context,
  api,
}) => {
  signedOutWith(api, 'plex');
  const plex = await mockPlexPin(page, context, api);
  await page.goto('/connexion?retour=%2Fdemandes');
  await expect(page.getByText('Avec votre compte Plex, sans nouvel identifiant.')).toBeVisible();
  await expect(page.getByLabel('Mot de passe')).toHaveCount(0);

  const popupOpened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Se connecter avec Plex' }).click();
  const popup = await popupOpened;
  await expect(popup).toHaveURL(/^https:\/\/app\.plex\.tv\/auth\//);
  await expect(page.getByRole('status')).toContainText('En attente de Plex…');
  await expect(page.getByRole('link', { name: 'Ouvrir la fenêtre Plex' })).toHaveAttribute('href', PLEX_AUTH_URL);
  await expect.poll(() => plex.pin.polls).toBeGreaterThan(0);

  plex.grant();
  await expect(page).toHaveURL(/\/demandes$/, { timeout: 10_000 });
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test('Plex : un compte sans accès au serveur est refusé, avec le message du serveur', async ({
  page,
  context,
  api,
}) => {
  signedOutWith(api, 'plex');
  const plex = await mockPlexPin(page, context, api, 'Ce compte Plex n’a pas accès à ce serveur');
  plex.grant();
  await page.goto('/connexion');
  await page.getByRole('button', { name: 'Se connecter avec Plex' }).click();
  await expect(page.getByRole('alert')).toHaveText('Ce compte Plex n’a pas accès à ce serveur');
  await expect(page).toHaveURL(/\/connexion$/);
  await expect(page.getByRole('button', { name: 'Se connecter avec Plex' })).toBeEnabled();
});

test('Plex : Annuler ferme l’attente', async ({ page, context, api }) => {
  signedOutWith(api, 'plex');
  await mockPlexPin(page, context, api);
  await page.goto('/connexion');
  const popupOpened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Se connecter avec Plex' }).click();
  const popup = await popupOpened;
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('button', { name: 'Se connecter avec Plex' })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test('Jellyfin : identifiant et mot de passe, au nom de Jellyfin', async ({ page, api }) => {
  signedOutWith(api, 'jellyfin');
  await page.goto('/connexion');
  await expect(page.getByText('Avec votre compte Jellyfin, sans nouvel identifiant.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Connexion avec votre compte Jellyfin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Se connecter avec Plex' })).toHaveCount(0);
});

const section = (page: Page) => page.getByRole('button', { name: /^Serveur multimédia\b/ });

test('assistant : le type d’abord, puis les champs de ce type', async ({ page, api }) => {
  api.state.setup = structuredClone(freshSetup);
  api.state.viewer = null;
  let body: unknown;
  await page.route('**/api/setup/mediaServer/test', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: plexTest });
  });
  await page.goto('/assistant');
  await expect(section(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: 'Type de serveur' })).toBeVisible();
  await expect(field(page, 'Adresse')).toHaveCount(0);

  await page.getByRole('radio', { name: /^Jellyfin/ }).check();
  await expect(field(page, 'Clé d’API')).toBeVisible();
  await expect(field(page, 'Adresse publique de Jellyfin')).toBeVisible();

  await page.getByRole('radio', { name: /^Plex/ }).check();
  await expect(field(page, 'Adresse publique de Plex')).toHaveCount(0);
  await field(page, 'Adresse').fill('http://192.0.2.20:32400');
  await field(page, 'Jeton Plex du propriétaire').fill('jeton-plex');
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /\S/ })).toHaveText(
    'Connexion réussie · Salon · Plex v1.41.3 · 3 bibliothèques',
  );
  expect(body).toEqual({ kind: 'plex', url: 'http://192.0.2.20:32400', apiKey: 'jeton-plex' });
  await expectNoAxeViolations(page);
});

test('Réglages : le type ne change plus une fois des membres inscrits', async ({ page, api }) => {
  api.state.setup = { ...api.state.setup, mediaServerKind: 'plex' };
  api.state.settings.mediaServer = {
    kind: 'plex',
    url: 'http://192.0.2.20:32400',
    apiKey: { set: true },
    libraryIds: ['lib-films'],
    publicUrl: null,
  };
  await page.route('**/api/setup/mediaServer/test', (route) => route.fulfill({ json: plexTest }));
  await page.goto('/reglages');
  await section(page).click();
  await expect(page.getByRole('radio', { name: /^Plex/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Emby/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /^Jellyfin/ })).toBeDisabled();
  await expect(page.getByText('Le type ne peut plus changer')).toBeVisible();
  await expectNoAxeViolations(page);
});

test('axe : aucune violation sur la connexion Plex, en attente comprise', async ({ page, context, api }) => {
  signedOutWith(api, 'plex');
  await mockPlexPin(page, context, api);
  await page.goto('/connexion');
  await expect(page.getByRole('button', { name: 'Se connecter avec Plex' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Se connecter avec Plex' }).click();
  await expect(page.getByRole('status')).toContainText('En attente de Plex…');
  await expectNoAxeViolations(page);
});
