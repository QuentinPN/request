import type { Page } from '@playwright/test';
import { expect, expectNoAxeViolations, field, test, viewerAs, webhookSettingsOf } from './support/api.ts';

const webhooksSection = (page: Page) => page.getByRole('button', { name: /^Webhooks\b/ });

async function openWebhooks(page: Page) {
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await webhooksSection(page).click();
  await expect(webhooksSection(page)).toHaveAttribute('aria-expanded', 'true');
}

test('Réglages : les adresses Radarr et Sonarr, et comment les brancher', async ({ page }) => {
  await openWebhooks(page);
  const initial = webhookSettingsOf('jeton-initial');
  await expect(field(page, 'Radarr')).toHaveValue(initial.urls.radarr);
  await expect(field(page, 'Sonarr')).toHaveValue(initial.urls.sonarr);
  await expect(field(page, 'Radarr')).toHaveAttribute('readonly', '');
  await expect(webhooksSection(page)).toContainText('Actif');
  await expect(page.getByText('Paramètres › Connexions › + › Webhook')).toBeVisible();
  await expect(page.getByText('POST', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('Copier place l’adresse dans le presse-papiers', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWebhooks(page);
  const copy = page.getByRole('button', { name: 'Copier l’adresse Sonarr' });
  await copy.click();
  await expect(copy).toHaveText('Copié');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    webhookSettingsOf('jeton-initial').urls.sonarr,
  );
});

test('sans presse-papiers (http sur le réseau local), pas de bouton : l’adresse reste sélectionnable', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await openWebhooks(page);
  await expect(page.getByRole('button', { name: /^Copier/ })).toHaveCount(0);
  await field(page, 'Radarr').focus();
  const selected = await field(page, 'Radarr').evaluate(
    (el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0),
  );
  expect(selected).toBe(webhookSettingsOf('jeton-initial').urls.radarr.length);
});

test('Régénérer le jeton demande confirmation, puis remplace les adresses', async ({ page, api }) => {
  await openWebhooks(page);
  let regenerated = 0;
  await page.route('**/api/settings/webhooks/token', (route) => {
    regenerated++;
    return route.fallback();
  });

  await page.getByRole('button', { name: 'Régénérer le jeton' }).click();
  const dialog = page.getByRole('dialog', { name: 'Régénérer le jeton ?' });
  await expect(dialog).toContainText('cessent de fonctionner');
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  expect(regenerated).toBe(0);
  await expect(field(page, 'Radarr')).toHaveValue(webhookSettingsOf('jeton-initial').urls.radarr);

  await page.getByRole('button', { name: 'Régénérer le jeton' }).click();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Régénérer', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(regenerated).toBe(1);
  await expect(field(page, 'Radarr')).toHaveValue(webhookSettingsOf('jeton-regenere').urls.radarr);
  await expect(field(page, 'Sonarr')).toHaveValue(webhookSettingsOf('jeton-regenere').urls.sonarr);
  await expect(page.getByText('Nouveau jeton généré')).toBeVisible();
  expect(api.state.webhooks.token).toBe('jeton-regenere');
});

test('Régénérer : l’échec du serveur reste dans la feuille, l’ancien jeton est gardé', async ({ page }) => {
  await openWebhooks(page);
  await page.route('**/api/settings/webhooks/token', (route) =>
    route.fulfill({ status: 500, json: { error: 'Erreur interne du serveur' } }),
  );
  await page.getByRole('button', { name: 'Régénérer le jeton' }).click();
  const dialog = page.getByRole('dialog', { name: 'Régénérer le jeton ?' });
  await dialog.getByRole('button', { name: 'Régénérer', exact: true }).click();
  await expect(dialog).toContainText('Erreur interne du serveur');
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(field(page, 'Radarr')).toHaveValue(webhookSettingsOf('jeton-initial').urls.radarr);
});

test('un jeton illisible : message et « Réessayer »', async ({ page }) => {
  let fail = true;
  await page.route('**/api/settings/webhooks', (route) =>
    fail ? route.fulfill({ status: 500, json: { error: 'Erreur interne du serveur' } }) : route.fallback(),
  );
  await openWebhooks(page);
  await expect(page.getByText('Les webhooks n’ont pas pu se charger.')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(field(page, 'Radarr')).toBeVisible();
});

test('pas de section Webhooks hors du propriétaire (Réglages lui est fermé)', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Marion');
  await page.goto('/reglages');
  await expect(page).toHaveURL(/\/$/);
  await expect(webhooksSection(page)).toHaveCount(0);
});
