import type { Page } from '@playwright/test';
import { membersFixture } from './membres-mocks.ts';
import { makeRequest, mediaNamed, mockRequests, person } from './requests-mocks.ts';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';

// Réglages › Membres : rôle et quotas, ses demandes, « Déconnecter partout » (propriétaire).

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

// Modifier un membre : rôle et quotas (propriétaire).

const editDialog = (page: Page, name: string) => page.getByRole('dialog', { name: `Modifier ${name}` });

async function openEdit(page: Page, name: string) {
  await openMembers(page);
  await page.getByRole('button', { name: `Modifier : ${name}` }).click();
  await expect(editDialog(page, name)).toBeVisible();
}

test('modifier : pas de bouton sur la ligne du propriétaire, un par autre membre', async ({ page, api }) => {
  api.state.members = membersFixture();
  await openMembers(page);
  await expect(page.getByRole('button', { name: /^Modifier :/ })).toHaveCount(2);
  const self = page.getByRole('listitem').filter({ hasText: 'Quentin' });
  await expect(self.getByRole('button')).toHaveCount(0);
  await expect(self.getByRole('link')).toHaveCount(0);
});

test('modifier : approbation automatique, enregistrée et affichée dans la liste', async ({ page, api }) => {
  api.state.members = membersFixture();
  await openEdit(page, 'Théo');
  const dialog = editDialog(page, 'Théo');
  // Trois rôles attribuables, chacun expliqué ; pas de « Propriétaire ».
  await expect(dialog.getByRole('radio', { name: /^Membre/ })).toBeChecked();
  await expect(dialog.getByText('approuvées et envoyées sans validation')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^Propriétaire/ })).toHaveCount(0);
  await expectNoAxeViolations(page);

  await dialog.getByRole('radio', { name: /^Approbation auto/ }).check();
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.state.memberUpdates).toEqual([{ id: 'id-Théo', body: { role: 'auto_approve', quotaOverride: null } }]);
  await expect(page.getByRole('listitem').filter({ hasText: 'Théo' })).toContainText('Approbation auto');
});

test('modifier : quotas propres, puis sans quota', async ({ page, api }) => {
  api.state.members = membersFixture();
  await openEdit(page, 'Théo');
  const dialog = editDialog(page, 'Théo');
  await expect(dialog.getByRole('radio', { name: /^Quotas par défaut/ })).toBeChecked();
  await expect(dialog.getByText('Actuellement : 10 films sur 7 jours')).toBeVisible();

  await dialog.getByRole('radio', { name: /^Quotas propres/ }).check();
  await dialog.getByLabel('Nombre de films').fill('2');
  await dialog.getByLabel('Nombre de saisons').fill('');
  await expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await dialog.getByLabel('Nombre de saisons').fill('4');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.state.memberUpdates.at(-1)).toEqual({
    id: 'id-Théo',
    body: { role: 'member', quotaOverride: { movies: { limit: 2, days: 7 }, seasons: { limit: 4, days: 7 } } },
  });
  await expect(page.getByRole('listitem').filter({ hasText: 'Théo' })).toContainText('Quotas propres');

  await page.getByRole('button', { name: 'Modifier : Théo' }).click();
  await expect(dialog.getByRole('radio', { name: /^Quotas propres/ })).toBeChecked();
  await expect(dialog.getByLabel('Nombre de films')).toHaveValue('2');
  await dialog.getByRole('radio', { name: /^Sans quota/ }).check();
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.state.memberUpdates.at(-1)?.body.quotaOverride).toEqual({ movies: null, seasons: null, unlimited: true });
  await expect(page.getByRole('listitem').filter({ hasText: 'Théo' })).toContainText('Sans quota');
});

test('modifier : un gestionnaire est hors quotas, le bloc des quotas est grisé et dit pourquoi', async ({
  page,
  api,
}) => {
  api.state.members = membersFixture();
  await openEdit(page, 'Théo');
  const dialog = editDialog(page, 'Théo');
  await dialog.getByRole('radio', { name: /^Gestionnaire/ }).check();
  await expect(dialog.getByText('Le rôle Gestionnaire est hors quotas')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^Sans quota/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /^Quotas par défaut/ })).toBeDisabled();
  await expectNoAxeViolations(page);

  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toHaveCount(0);
  // Les quotas enregistrés ne sont pas touchés.
  expect(api.state.memberUpdates).toEqual([{ id: 'id-Théo', body: { role: 'manager' } }]);
  await expect(page.getByRole('listitem').filter({ hasText: 'Théo' })).toContainText('Gestionnaire');
});

test('modifier : l’échec du serveur reste dans la fenêtre', async ({ page, api }) => {
  api.state.members = membersFixture();
  await openEdit(page, 'Marion');
  await page.route('**/api/users/*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 403, json: { error: 'Le propriétaire ne se modifie pas depuis l’appli' } })
      : route.fallback(),
  );
  const dialog = editDialog(page, 'Marion');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toContainText('Le propriétaire ne se modifie pas depuis l’appli');
});

// Voir ses demandes : lien vers Mes demandes filtré sur le membre.

/** Une demande en attente de Marion, une envoyée de Théo, une en attente du propriétaire connecté. */
async function mockThreeMembersRequests(page: Page) {
  const requests = await mockRequests(page);
  requests.requests = [
    makeRequest(mediaNamed('Gladiator II'), 'pending', { requester: person('Marion') }),
    makeRequest(mediaNamed('Conclave'), 'sent', { requester: person('Théo') }),
    makeRequest(mediaNamed('Flow'), 'pending'),
  ];
  return requests;
}

const requestRows = (page: Page) =>
  page
    .getByRole('list', { name: /^Demandes/ })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link') });

test('« Voir ses demandes » : la page montre celles du membre, sans pouvoir les annuler', async ({ page, api }) => {
  api.state.members = membersFixture();
  const requests = await mockThreeMembersRequests(page);
  await openMembers(page);
  await page.getByRole('link', { name: 'Voir ses demandes : Marion' }).click();
  await expect(page).toHaveURL(/\/demandes\?membre=id-Marion$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes de Marion' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Demandes de' })).toHaveValue('id-Marion');
  await expect(requestRows(page)).toHaveCount(1);
  await expect(requestRows(page).first()).toContainText('Gladiator II');
  await expect(page.getByRole('button', { name: /^Annuler la demande/ })).toHaveCount(0);
  expect(requests.listReads.at(-1)).toContain('userId=id-Marion');
  await expectNoAxeViolations(page);
});

test('Mes demandes : le sélecteur d’un gestionnaire passe de « Moi » à un membre ou à tous', async ({ page, api }) => {
  api.state.members = membersFixture();
  await mockThreeMembersRequests(page);
  await page.goto('/demandes');
  await expect(page.getByRole('heading', { level: 1, name: 'Mes demandes' })).toBeVisible();
  const picker = page.getByRole('combobox', { name: 'Demandes de' });
  await expect(requestRows(page)).toHaveCount(1);
  await expect(requestRows(page).first()).toContainText('Flow');
  // Soi-même n'est pas listé parmi les membres.
  await expect(picker.getByRole('option')).toHaveText(['Moi', 'Tous les membres', 'Marion', 'Théo']);

  await picker.selectOption('tous');
  await expect(page).toHaveURL(/membre=tous/);
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes de tous les membres' })).toBeVisible();
  await expect(requestRows(page)).toHaveCount(3);
  await expect(requestRows(page).filter({ hasText: 'Conclave' })).toContainText('Membre : Théo');

  await picker.selectOption('id-Théo');
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes de Théo' })).toBeVisible();
  await expect(requestRows(page)).toHaveCount(1);

  await picker.selectOption('');
  await expect(page.getByRole('heading', { level: 1, name: 'Mes demandes' })).toBeVisible();
  await expect(requestRows(page)).toHaveCount(1);
});

test('Mes demandes : un membre n’a pas de sélecteur et ignore ?membre=', async ({ page, api }) => {
  api.state.viewer = viewerAs('member', 'Théo');
  const requests = await mockRequests(page);
  requests.requests = [makeRequest(mediaNamed('Flow'), 'pending')];
  await page.goto('/demandes?membre=id-Marion');
  await expect(page.getByRole('heading', { level: 1, name: 'Mes demandes' })).toBeVisible();
  await expect(requestRows(page)).toHaveCount(1);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(requests.listReads).not.toHaveLength(0);
  expect(requests.listReads.every((query) => !query.includes('userId'))).toBe(true);
});
