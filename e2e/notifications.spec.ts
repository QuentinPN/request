import type { Page } from '@playwright/test';
import { mockNotifications } from './notifications-mocks.ts';
import { expect, expectNoAxeViolations, test } from './support/api.ts';
import { mobileTabs } from './support/nav.ts';

const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

test('ordinateur : la cloche signale les non lues, le panneau les liste et « Tout marquer comme lu »', async ({
  page,
}, { project }) => {
  test.skip(project.name !== 'ordinateur', 'cloche de l’en-tête réservée à l’ordinateur');
  const state = await mockNotifications(page);
  await page.goto('/demandes');
  const bell = page.getByRole('button', { name: 'Notifications, 2 non lues' });
  await bell.focus();
  await page.keyboard.press('Enter');

  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: /Disponible dans Emby/ })).toHaveAttribute(
    'href',
    '/titre/movie/693134',
  );
  await expect(dialog.getByRole('link', { name: /Nouvelle demande à approuver/ })).toHaveAttribute(
    'href',
    '/approbations',
  );
  await expect(dialog.getByText('Motif : Déjà disponible en VO', { exact: false })).toBeVisible();
  await expectNoAxeViolations(page);

  await dialog.getByRole('button', { name: 'Tout marquer comme lu' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tout marquer comme lu' })).toBeHidden();
  expect(state.reads).toEqual([{ all: true }]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('ordinateur : ouvrir une notification la marque lue et mène à sa page', async ({ page }, { project }) => {
  test.skip(project.name !== 'ordinateur', 'cloche de l’en-tête réservée à l’ordinateur');
  const state = await mockNotifications(page);
  await page.goto('/demandes');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await panel(page)
    .getByRole('link', { name: /Nouvelle demande à approuver/ })
    .click();

  await expect(page).toHaveURL(/\/approbations$/);
  await expect(panel(page)).toBeHidden();
  expect(state.reads).toEqual([{ ids: [2] }]);
  await expect(page.getByRole('button', { name: 'Notifications, 1 non lue' })).toBeVisible();
});

test('mobile : la cloche de l’en-tête ouvre la feuille des notifications, la barre garde ses cinq onglets', async ({
  page,
}, { project }) => {
  test.skip(project.name !== 'mobile', 'en-tête et barre d’onglets réservés au mobile');
  const state = await mockNotifications(page);
  await page.goto('/demandes');
  const tabs = mobileTabs(page);
  // Propriétaire : cinq onglets, la cloche n'en fait pas partie.
  await expect(tabs.locator(':scope > a, :scope > button')).toHaveCount(5);
  await expect(tabs.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);

  const bell = page.getByRole('button', { name: 'Notifications, 2 non lues' });
  const box = await bell.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await bell.tap();
  const sheet = panel(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('link', { name: /Disponible dans Emby/ })).toBeVisible();
  await expectNoAxeViolations(page);

  await sheet.getByRole('button', { name: 'Tout marquer comme lu' }).tap();
  await expect(sheet.getByRole('button', { name: 'Tout marquer comme lu' })).toBeHidden();
  expect(state.reads).toEqual([{ all: true }]);
  // La feuille est modale : la barre redevient accessible une fois fermée.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('sans notification : panneau vide et aucune pastille', async ({ page }) => {
  await page.goto('/demandes');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(panel(page).getByText('Aucune notification')).toBeVisible();
  await expectNoAxeViolations(page);
});
