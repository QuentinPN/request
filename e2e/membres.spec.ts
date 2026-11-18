import type { Page } from '@playwright/test';
import { membersFixture } from './membres-mocks.ts';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';

// Réglages › Membres : « Déconnecter partout » (propriétaire).

const section = (page: Page) => page.getByRole('button', { name: /^Membres\b/ });

async function openMembers(page: Page) {
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await section(page).click();
  await expect(section(page)).toHaveAttribute('aria-expanded', 'true');
}

test('Réglages › Membres : la liste, les rôles, la dernière connexion et pas de bouton sur sa propre ligne', async ({
  page,
  api,
}) => {
  api.state.members = membersFixture();
  await openMembers(page);
  await expect(section(page)).toContainText('3 membres');
  await expect(page.getByText('ferme toutes les sessions du membre sur tous ses appareils')).toBeVisible();

  const rows = page.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  const self = rows.filter({ hasText: 'Quentin' });
  await expect(self).toContainText('Vous');
  await expect(self).toContainText('Propriétaire');
  await expect(self).toContainText('Dernière connexion : 17 nov.');
  await expect(self.getByRole('button')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Marion' })).toContainText('Gestionnaire');
  await expect(rows.filter({ hasText: 'Théo' })).toContainText('Jamais connecté');
  await expect(page.getByRole('button', { name: /^Déconnecter partout/ })).toHaveCount(2);
  await expectNoAxeViolations(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('déconnecter un membre : confirmation, requête DELETE, message', async ({ page, api }) => {
  api.state.members = membersFixture();
  const deletes: string[] = [];
  page.on('request', (req) => req.method() === 'DELETE' && deletes.push(new URL(req.url()).pathname));
  await openMembers(page);

  await page.getByRole('button', { name: 'Déconnecter partout : Marion' }).click();
  const dialog = page.getByRole('dialog', { name: 'Déconnecter Marion partout ?' });
  await expect(dialog).toContainText('Il devra se reconnecter');
  await expectNoAxeViolations(page);

  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.state.signedOut).toEqual([]);

  await page.getByRole('button', { name: 'Déconnecter partout : Marion' }).click();
  await dialog.getByRole('button', { name: 'Déconnecter', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Marion est déconnecté de tous ses appareils.');
  expect(deletes).toEqual(['/api/users/id-Marion/sessions']);
  expect(api.state.signedOut).toEqual(['id-Marion']);
  await expectNoAxeViolations(page);
});

test('déconnecter : l’échec du serveur reste dans la boîte de confirmation', async ({ page, api }) => {
  api.state.members = membersFixture();
  await openMembers(page);
  await page.route('**/api/users/*/sessions', (route) =>
    route.fulfill({ status: 404, json: { error: 'Membre introuvable' } }),
  );
  await page.getByRole('button', { name: 'Déconnecter partout : Théo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Déconnecter Théo partout ?' });
  await dialog.getByRole('button', { name: 'Déconnecter', exact: true }).click();
  await expect(dialog).toContainText('Membre introuvable');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('une liste illisible : message et « Réessayer »', async ({ page, api }) => {
  api.state.members = membersFixture();
  let fail = true;
  await page.route('**/api/users', (route) =>
    fail ? route.fulfill({ status: 500, json: { error: 'Erreur interne du serveur' } }) : route.fallback(),
  );
  await openMembers(page);
  await expect(page.getByText('Les membres n’ont pas pu se charger.')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(3);
});

test('pas de section Membres hors du propriétaire', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Marion');
  await page.goto('/reglages');
  await expect(page.getByRole('button', { name: /^Blocages/ })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
});
