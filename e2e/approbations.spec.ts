import type { Page } from '@playwright/test';
import { makeRequest, mockApprovalQueue, type RequestsMock, stubMedia } from './requests-mocks.ts';
import { test as base, expect, expectNoAxeViolations, viewerAs } from './support/api.ts';

const test = base.extend<{ requests: RequestsMock }>({
  // `auto` : même sans l'appeler, le faux serveur des demandes répond (compteur de la navigation, par exemple).
  requests: [
    async ({ page }, use) => {
      await use(await mockApprovalQueue(page));
    },
    { auto: true },
  ],
});

const onlyDesktop = (project: { name: string }) =>
  test.skip(project.name !== 'ordinateur', 'écran d’ordinateur : tableau et panneau');
const onlyMobile = (project: { name: string }) =>
  test.skip(project.name !== 'mobile', 'écran mobile : carte par carte');

const panel = (page: Page) => page.getByRole('complementary', { name: 'Détail de la demande' });
const row = (page: Page, title: string) => page.getByRole('row', { name: new RegExp(title) });

test('ordinateur : la file affiche les demandes en attente et le détail de la première', async ({ page }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await expect(page.getByRole('heading', { level: 1, name: 'Approbations' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(4); // en-tête + 3 demandes
  await expect(row(page, 'Conclave')).toContainText('Marion');
  await expect(panel(page).getByRole('heading', { name: 'Conclave' })).toBeVisible();
  await expect(panel(page).getByLabel('Profil de qualité')).toHaveValue('4');
  await expect(panel(page).getByText('Espace libre : 412 Go')).toBeVisible();
  // Bandeau de l'envoi en échec, relançable d'ici.
  await expect(page.getByRole('alert').filter({ hasText: 'Gladiator II' })).toContainText('dossier /films plein');
});

test('ordinateur : approuver avec un autre profil et un autre dossier envoie ce choix', async ({ page, requests }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await panel(page).getByLabel('Profil de qualité').selectOption({ label: 'Ultra-HD' });
  await panel(page).getByLabel('Dossier racine').selectOption('/films-4k');
  await expect(panel(page).getByText('Espace libre : 1,8 To')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Approuver et envoyer' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Conclave envoyée à Radarr.' })).toBeVisible();
  expect(requests.approvals).toEqual([{ id: 1, body: { qualityProfileId: 5, rootFolderPath: '/films-4k' } }]);
  await expect(row(page, 'Conclave')).toHaveCount(0);
  // La sélection passe à la demande suivante.
  await expect(panel(page).getByRole('heading', { name: 'Andor' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toContainText('2');
});

test('ordinateur : un gestionnaire choisit aussi le profil et le dossier', async ({ page, api, requests }, {
  project,
}) => {
  onlyDesktop(project);
  api.state.viewer = viewerAs('manager', 'Camille');
  await page.goto('/approbations');
  await expect(panel(page).getByLabel('Profil de qualité')).toHaveValue('4');
  await panel(page).getByLabel('Dossier racine').selectOption('/films-4k');
  await panel(page).getByRole('button', { name: 'Approuver et envoyer' }).click();
  await expect(page.getByRole('status')).toContainText('Conclave envoyée à Radarr.');
  expect(requests.approvals).toEqual([{ id: 1, body: { rootFolderPath: '/films-4k' } }]);
});

test('ordinateur : l’historique se pagine côté serveur, 20 demandes par page', async ({ page, requests }, {
  project,
}) => {
  onlyDesktop(project);
  const older = Array.from({ length: 20 }, (_, i) =>
    makeRequest(stubMedia(2000 + i, `Archive ${i + 1}`), 'sent', { id: 100 + i, day: 1 }),
  );
  requests.requests = [...requests.requests, ...older];
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Historique' }).click();
  await expect(page.getByRole('row')).toHaveCount(21); // en-tête + 20
  await expect(page.getByText('Page 1 sur 2')).toBeVisible();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByRole('row')).toHaveCount(3); // en-tête + les 2 dernières
});

test('ordinateur : approuver sans rien changer n’envoie aucun choix', async ({ page, requests }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Approuver Furiosa' }).click();
  await expect(page.getByRole('status')).toContainText('Furiosa envoyée à Radarr.');
  expect(requests.approvals).toEqual([{ id: 3, body: {} }]);
});

test('ordinateur : Radarr qui refuse l’envoi est dit en français et la demande passe en échec', async ({
  page,
  requests,
}, { project }) => {
  onlyDesktop(project);
  requests.sendOutcome = 'failed';
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Approuver Conclave' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Radarr n’a pas pu la recevoir' })).toContainText(
    'Elle est dans Échecs',
  );
});

test('ordinateur : un refus demande un motif', async ({ page, requests }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await panel(page).getByRole('button', { name: 'Refuser', exact: true }).click();
  await expect(panel(page).getByText('Motif requis')).toBeVisible();
  expect(requests.declines).toEqual([]);

  await panel(page).getByLabel('Motif si refus').fill('Déjà prévu pour la semaine prochaine');
  await panel(page).getByRole('button', { name: 'Refuser', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Conclave refusée.');
  expect(requests.declines).toEqual([{ id: 1, body: { reason: 'Déjà prévu pour la semaine prochaine' } }]);
});

test('ordinateur : le refus depuis une ligne passe par une feuille qui exige le motif', async ({ page, requests }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Refuser Andor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Refuser Andor' });
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog.getByText('Motif requis')).toBeVisible();
  await dialog.getByLabel('Motif si refus').fill('   ');
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog.getByText('Motif requis')).toBeVisible();
  expect(requests.declines).toEqual([]);

  await dialog.getByLabel('Motif si refus').fill('Série déjà en cours chez un autre membre');
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog).toBeHidden();
  expect(requests.declines).toEqual([{ id: 2, body: { reason: 'Série déjà en cours chez un autre membre' } }]);
});

test('ordinateur : approbation groupée de toute la page', async ({ page, requests }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await expect(page.getByRole('button', { name: 'Refuser la sélection' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Sélectionner Conclave' }).check();
  await expect(page.getByText('1 sélectionnée')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approuver la sélection' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Tout sélectionner' }).check();
  await expect(page.getByText('3 sélectionnées')).toBeVisible();
  await page.getByRole('button', { name: 'Tout approuver' }).click();

  await expect(page.getByRole('status')).toContainText('3 demandes envoyées.');
  expect(requests.batches).toEqual([{ action: 'approve', ids: [1, 2, 3] }]);
  await expect(page.getByText('Rien à approuver')).toBeVisible();
});

test('ordinateur : refus groupé avec motif obligatoire', async ({ page, requests }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('checkbox', { name: 'Sélectionner Conclave' }).check();
  await page.getByRole('checkbox', { name: 'Sélectionner Furiosa' }).check();
  await page.getByRole('button', { name: 'Refuser la sélection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Refuser 2 demandes' });
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog.getByText('Motif requis')).toBeVisible();
  expect(requests.batches).toEqual([]);

  await dialog.getByLabel('Motif si refus').fill('Trop de demandes cette semaine');
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(page.getByRole('status')).toContainText('2 demandes refusées.');
  expect(requests.batches).toEqual([{ action: 'decline', ids: [1, 3], reason: 'Trop de demandes cette semaine' }]);
});

test('ordinateur : ↑ ↓ déplacent la sélection d’une ligne à l’autre', async ({ page }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  const conclave = row(page, 'Conclave')
    .getByRole('button', { name: /Conclave/, exact: false })
    .first();
  await conclave.focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel(page).getByRole('heading', { name: 'Andor' })).toBeVisible();
  await expect(row(page, 'Andor').getByRole('button').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(panel(page).getByRole('heading', { name: 'Conclave' })).toBeVisible();
});

test('ordinateur : l’onglet Échecs montre la raison et relance l’envoi', async ({ page, requests }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: /^Échecs/ }).click();
  await expect(row(page, 'Gladiator II')).toContainText('dossier /films plein');
  await expect(panel(page).getByText(/Radarr n’a pas pu recevoir cette demande/)).toBeVisible();
  await page.getByRole('button', { name: 'Réessayer Gladiator II' }).click();
  await expect(page.getByRole('status')).toContainText('Gladiator II envoyée à Radarr.');
  expect(requests.retries).toEqual([4]);
  await expect(page.getByText('Aucun échec d’envoi')).toBeVisible();
});

test('ordinateur : le bandeau d’échec de l’onglet En attente relance aussi', async ({ page, requests }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Réessayer Gladiator II' }).click();
  await expect(page.getByRole('status')).toContainText('Gladiator II envoyée à Radarr.');
  expect(requests.retries).toEqual([4]);
});

test('ordinateur : l’historique est en lecture seule', async ({ page }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Historique' }).click();
  await expect(page.getByRole('row')).toHaveCount(3); // en-tête + envoyée + refusée
  await expect(row(page, 'Dune')).toContainText('Envoyée');
  await expect(page.getByRole('button', { name: /^(Approuver|Refuser|Réessayer)/ })).toHaveCount(0);
  await row(page, 'Tenet').getByRole('button').first().click();
  await expect(panel(page)).toContainText('Déjà dans la bibliothèque');
  await expect(panel(page)).toContainText('Décidé par');
});

test('ordinateur : une panne du serveur est dite en français et rien ne se perd', async ({ page }, { project }) => {
  onlyDesktop(project);
  await page.goto('/approbations');
  await page.route(/\/api\/requests\/1\/approve$/, (route) =>
    route.fulfill({ status: 409, json: { error: 'Cette demande a déjà été traitée' } }),
  );
  await page.getByRole('button', { name: 'Approuver Conclave' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Cette demande a déjà été traitée' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approuver Conclave' })).toBeEnabled();
});

test('mobile : une carte à la fois, « Plus tard » la repousse, Approuver passe à la suivante', async ({
  page,
  requests,
}, { project }) => {
  onlyMobile(project);
  await page.goto('/approbations');
  await expect(page.getByRole('article', { name: 'Conclave' })).toBeVisible();
  await expect(page.getByText('1 sur 3')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(0);

  await page.getByRole('button', { name: 'Plus tard' }).click();
  await expect(page.getByRole('article', { name: 'Andor' })).toBeVisible();
  await page.getByRole('button', { name: 'Approuver', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Furiosa' })).toBeVisible();
  expect(requests.approvals).toEqual([{ id: 2, body: {} }]);
  await expect(page.getByText('2 sur 3')).toBeVisible();

  // La carte repoussée revient quand les autres sont traitées.
  await page.getByRole('button', { name: 'Plus tard' }).click();
  await expect(page.getByRole('article', { name: 'Conclave' })).toBeVisible();
});

test('mobile : Refuser ouvre une feuille qui exige le motif', async ({ page, requests }, { project }) => {
  onlyMobile(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: 'Refuser', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Refuser Conclave' });
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog.getByText('Motif requis')).toBeVisible();
  expect(requests.declines).toEqual([]);

  await dialog.getByLabel('Motif si refus').fill('Pas de VF disponible');
  await dialog.getByRole('button', { name: 'Refuser' }).click();
  await expect(dialog).toBeHidden();
  expect(requests.declines).toEqual([{ id: 1, body: { reason: 'Pas de VF disponible' } }]);
  await expect(page.getByRole('article', { name: 'Andor' })).toBeVisible();
});

test('mobile : l’onglet Échecs relance depuis une carte', async ({ page, requests }, { project }) => {
  onlyMobile(project);
  await page.goto('/approbations');
  await page.getByRole('button', { name: /^Échecs/ }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Gladiator II' })).toContainText('dossier /films plein');
  await page.getByRole('button', { name: /^Réessayer Gladiator II/ }).click();
  expect(requests.retries).toEqual([4]);
});

test('un membre n’a pas accès à la file : retour à l’accueil, sans entrée dans la navigation', async ({ page, api }, {
  project,
}) => {
  api.state.viewer = viewerAs('member', 'Marion');
  await page.goto('/approbations');
  await expect(page).toHaveURL(/\/$/);
  const nav = page.getByRole('navigation', {
    name: project.name === 'mobile' ? 'Navigation' : 'Navigation principale',
  });
  await expect(nav.getByRole('link', { name: /Approb|Approuver/ })).toHaveCount(0);
});

test('le compteur de la navigation suit les demandes en attente', async ({ page }, { project }) => {
  const mobile = project.name === 'mobile';
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: mobile ? 'Navigation' : 'Navigation principale' });
  const link = nav.getByRole('link', { name: mobile ? 'Approuver' : 'Approbations' });
  await expect(link).toHaveAccessibleName(`${mobile ? 'Approuver' : 'Approbations'} , 3 en attente`);
  await expect(link).toContainText('3');
  // Le compteur n'est que sur cette entrée.
  await expect(nav.getByRole('link', { name: 'Découvrir', exact: true })).toBeVisible();

  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approbations' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Approuver', exact: true })
    .or(page.getByRole('button', { name: 'Approuver Conclave' }))
    .first()
    .click();
  await expect(link).toHaveAccessibleName(`${mobile ? 'Approuver' : 'Approbations'} , 2 en attente`);
});

test('sans demande en attente, aucun compteur', async ({ page, requests }) => {
  requests.requests = requests.requests.filter((r) => r.status !== 'pending');
  await page.goto('/');
  await expect(page.getByRole('link', { name: /^(Approbations|Approuver)$/ })).toBeVisible();
});

test('axe : aucune violation (file, onglet Échecs, feuille de refus)', async ({ page }, { project }) => {
  await page.goto('/approbations');
  await expect(page.getByText('Conclave').first()).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: /^Échecs/ }).click();
  await expect(page.getByText('dossier /films plein').first()).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'En attente' }).click();
  const decline =
    project.name === 'mobile'
      ? page.getByRole('button', { name: 'Refuser', exact: true })
      : page.getByRole('button', { name: 'Refuser Conclave' });
  await decline.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoAxeViolations(page);
});
