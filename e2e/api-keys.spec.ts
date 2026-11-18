import type { Page } from '@playwright/test';
import { API_KEY_SECRET, expect, expectNoAxeViolations, field, test, viewerAs } from './support/api.ts';

const section = (page: Page) => page.getByRole('button', { name: /^API\b/ });

async function openApi(page: Page) {
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await section(page).click();
  await expect(section(page)).toHaveAttribute('aria-expanded', 'true');
}

async function createKey(page: Page, name: string) {
  await field(page, 'Nom de la clé').fill(name);
  await page.getByRole('button', { name: 'Créer la clé' }).click();
}

test('Réglages › API : aucune clé au départ, création impossible sans nom', async ({ page }) => {
  await openApi(page);
  await expect(section(page)).toContainText('Aucune clé');
  await expect(page.getByText('X-Api-Key', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeDisabled();
  await expect(page.getByRole('list')).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('créer une clé : elle s’affiche une seule fois, avec un bouton copier', async ({ page, context, api }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApi(page);
  await createKey(page, 'Home Assistant');

  const dialog = page.getByRole('dialog', { name: 'Clé créée' });
  await expect(dialog).toContainText('ne sera plus jamais affichée');
  await expect(dialog.getByLabel('Clé d’API')).toHaveValue(API_KEY_SECRET);
  await expectNoAxeViolations(page);
  const copy = dialog.getByRole('button', { name: 'Copier la clé' });
  await copy.click();
  await expect(copy).toHaveText('Copié');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(API_KEY_SECRET);

  await dialog.getByRole('button', { name: 'J’ai copié la clé' }).click();
  await expect(dialog).toHaveCount(0);
  // La liste montre le préfixe, jamais la clé complète.
  const row = page.getByRole('listitem').filter({ hasText: 'Home Assistant' });
  await expect(row).toContainText(`${API_KEY_SECRET.slice(0, 8)}…`);
  await expect(row).toContainText('Jamais utilisée');
  await expect(page.locator('body')).not.toContainText(API_KEY_SECRET);
  await expect(section(page)).toContainText('1 clé active');
  expect(api.state.apiKeys).toHaveLength(1);
});

test('sans presse-papiers (http sur le réseau local), pas de bouton : la clé reste sélectionnable', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await openApi(page);
  await createKey(page, 'Script');
  const dialog = page.getByRole('dialog', { name: 'Clé créée' });
  await expect(dialog.getByRole('button', { name: /^Copier/ })).toHaveCount(0);
  await dialog.getByLabel('Clé d’API').focus();
  const selected = await dialog
    .getByLabel('Clé d’API')
    .evaluate((el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0));
  expect(selected).toBe(API_KEY_SECRET.length);
});

test('révoquer demande confirmation, puis la clé reste listée comme révoquée', async ({ page, api }) => {
  await openApi(page);
  await createKey(page, 'Home Assistant');
  await page.getByRole('button', { name: 'J’ai copié la clé' }).click();

  await page.getByRole('button', { name: 'Révoquer la clé Home Assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Révoquer cette clé ?' });
  await expect(dialog).toContainText('cessent de fonctionner');
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.state.apiKeys[0]?.revokedAt).toBeNull();

  await page.getByRole('button', { name: 'Révoquer la clé Home Assistant' }).click();
  await dialog.getByRole('button', { name: 'Révoquer', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('listitem').filter({ hasText: 'Home Assistant' });
  await expect(row).toContainText('Révoquée');
  await expect(row.getByRole('button', { name: /^Révoquer/ })).toHaveCount(0);
  await expect(section(page)).toContainText('Aucune clé');
});

test('révoquer : l’échec du serveur reste dans la feuille', async ({ page }) => {
  await openApi(page);
  await createKey(page, 'Script');
  await page.getByRole('button', { name: 'J’ai copié la clé' }).click();
  await page.route('**/api/settings/api-keys/*', (route) =>
    route.fulfill({ status: 500, json: { error: 'Erreur interne du serveur' } }),
  );
  await page.getByRole('button', { name: 'Révoquer la clé Script' }).click();
  const dialog = page.getByRole('dialog', { name: 'Révoquer cette clé ?' });
  await dialog.getByRole('button', { name: 'Révoquer', exact: true }).click();
  await expect(dialog).toContainText('Erreur interne du serveur');
});

test('une liste illisible : message et « Réessayer »', async ({ page }) => {
  let fail = true;
  await page.route('**/api/settings/api-keys', (route) =>
    fail ? route.fulfill({ status: 500, json: { error: 'Erreur interne du serveur' } }) : route.fallback(),
  );
  await openApi(page);
  await expect(page.getByText('Les clés d’API n’ont pas pu se charger.')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(field(page, 'Nom de la clé')).toBeVisible();
});

test('pas de section API hors du propriétaire (un gestionnaire n’y voit que les blocages)', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Marion');
  await page.goto('/reglages');
  await expect(page.getByRole('button', { name: /^Blocages/ })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
});
