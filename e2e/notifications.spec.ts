import type { Page } from '@playwright/test';
import { mockNotifications } from './notifications-mocks.ts';
import { expect, expectNoAxeViolations, test } from './support/api.ts';

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

test('mobile : l’onglet « Alertes » tient dans la barre et ouvre la feuille des notifications', async ({ page }, {
  project,
}) => {
  test.skip(project.name !== 'mobile', 'barre d’onglets réservée au mobile');
  const state = await mockNotifications(page);
  await page.goto('/demandes');
  const tabs = page.getByRole('navigation', { name: 'Navigation', exact: true });
  // Propriétaire : sept onglets, tous dans la barre, sans chevauchement.
  const bar = await tabs.boundingBox();
  const boxes = await Promise.all(
    (await tabs.locator(':scope > a, :scope > button').all()).map((el) => el.boundingBox()),
  );
  expect(boxes).toHaveLength(7);
  for (const [i, box] of boxes.entries()) {
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box && bar && box.x >= bar.x && box.x + box.width <= bar.x + bar.width).toBe(true);
    const next = boxes[i + 1];
    if (box && next) expect(box.x + box.width).toBeLessThanOrEqual(next.x);
  }

  await tabs.getByRole('button', { name: /^Alertes ?, 2 non lues$/ }).tap();
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
  await expect(tabs.getByRole('button', { name: 'Alertes', exact: true })).toBeVisible();
});

test('sans notification : panneau vide et aucune pastille', async ({ page }, { project }) => {
  await page.goto('/demandes');
  if (project.name === 'mobile') await page.getByRole('button', { name: 'Alertes', exact: true }).tap();
  else await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(panel(page).getByText('Aucune notification')).toBeVisible();
  await expectNoAxeViolations(page);
});
