import type { Page } from '@playwright/test';
import type { BlockedTitle } from '../src/shared/blocklist.ts';
import { fixtures, mockCatalogue } from './catalogue-mocks.ts';
import { makeRequest, memberNamed, mockApprovalQueue, mockRequests, person, stubMedia } from './requests-mocks.ts';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';

// Ajustements des demandes (7.9) : demande pour autrui, hors quota, blocages de titres et de mots-clés.

const blockedTitle = (tmdbId: number, title: string): BlockedTitle => ({
  mediaType: 'tv',
  tmdbId,
  title,
  blockedBy: 'Camille',
  createdAt: '2026-11-10T09:00:00.000Z',
});

const sheet = (page: Page) => page.getByRole('dialog');

async function openFlowSheet(page: Page) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Tendances' }).getByRole('button', { name: 'Demander Flow' }).click();
  await expect(sheet(page).getByRole('heading', { name: 'Flow' })).toBeVisible();
}

test('un gestionnaire demande pour un membre, hors quota : le quota lu est celui du membre', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Camille');
  api.state.members = [memberNamed('Marion'), memberNamed('Théo'), memberNamed('Camille')];
  await mockCatalogue(page);
  const requests = await mockRequests(page);
  await openFlowSheet(page);

  const picker = sheet(page).getByRole('group', { name: 'Demander pour' });
  await expect(picker.getByRole('radio', { name: 'Moi' })).toBeChecked();
  await picker.getByLabel('Rechercher un membre').fill('mar');
  await expect(picker.getByRole('radio')).toHaveCount(2); // Moi + Marion
  await picker.getByRole('radio', { name: 'Marion' }).check();
  await expect.poll(() => requests.quotaReads).toContain('id-Marion');
  await sheet(page)
    .getByRole('checkbox', { name: /Hors quota/ })
    .check();
  await expect(sheet(page).getByText('Ne compte pas dans le quota de Marion.')).toBeVisible();
  await expectNoAxeViolations(page);

  await sheet(page).getByRole('button', { name: 'Demander ce film' }).click();
  await expect(sheet(page).getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'movie', tmdbId: 1007, forUserId: 'id-Marion', quotaExempt: true }]);
  expect(requests.quotaReads[0]).toBe('moi');
});

test('un membre ne voit ni le sélecteur de membre ni « Hors quota »', async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page);
  await mockRequests(page);
  await openFlowSheet(page);
  await expect(sheet(page).getByRole('button', { name: 'Demander ce film' })).toBeVisible();
  await expect(sheet(page).getByRole('group', { name: 'Demander pour' })).toHaveCount(0);
  await expect(sheet(page).getByRole('checkbox', { name: /Hors quota/ })).toHaveCount(0);
});

test('la file affiche « Demandée par X pour Y » et approuve hors quota', async ({ page, api }, { project }) => {
  test.skip(project.name !== 'ordinateur', 'tableau et panneau');
  api.state.viewer = viewerAs('manager', 'Camille');
  const requests = await mockApprovalQueue(page);
  requests.requests[0] = makeRequest(stubMedia(1001, 'Conclave'), 'pending', {
    id: 1,
    requester: person('Marion'),
    createdBy: person('Camille'),
  });
  await page.goto('/approbations');
  const panel = page.getByRole('complementary', { name: 'Détail de la demande' });
  await expect(page.getByRole('row', { name: /Conclave/ })).toContainText('Demandée par Camille pour Marion');
  await panel.getByRole('checkbox', { name: /Hors quota/ }).check();
  await panel.getByRole('button', { name: 'Approuver et envoyer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Conclave envoyée à Radarr.' })).toBeVisible();
  expect(requests.approvals).toEqual([{ id: 1, body: { quotaExempt: true } }]);
});

test('fiche bloquée par mot-clé : pastille « Bloqué », plus de bouton Demander', async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page, { tv: { ...fixtures.tv, blocked: { by: 'keyword', keyword: 'anime' } } });
  await mockRequests(page);
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByText('Bloqué (mot-clé « anime »)')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();
  // Les affiches des recommandations gardent leur « Demander <titre> » : seul celui de la fiche disparaît.
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Demander en 4K' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bloquer ce titre' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('un gestionnaire bloque un titre depuis la fiche, après confirmation', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Camille');
  await mockCatalogue(page);
  await mockRequests(page);
  await page.goto(`/titre/movie/${fixtures.movie.tmdbId}`);
  await page.getByRole('button', { name: 'Bloquer ce titre' }).click();
  const dialog = page.getByRole('dialog', { name: `Bloquer « ${fixtures.movie.title} » ?` });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  expect(api.state.blocklist.titles).toEqual([]);

  await page.getByRole('button', { name: 'Bloquer ce titre' }).click();
  await dialog.getByRole('button', { name: 'Bloquer', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.state.blocklist.titles).toMatchObject([{ mediaType: 'movie', tmdbId: fixtures.movie.tmdbId }]);
});

test('un gestionnaire débloque un titre bloqué depuis sa fiche', async ({ page, api }) => {
  api.state.viewer = viewerAs('manager', 'Camille');
  api.state.blocklist.titles = [blockedTitle(fixtures.tv.tmdbId, fixtures.tv.title)];
  await mockCatalogue(page, { tv: { ...fixtures.tv, blocked: { by: 'title' } } });
  await mockRequests(page);
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByText('Bloqué', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Débloquer' }).click();
  await expect.poll(() => api.state.blocklist.titles).toEqual([]);
});

test('Réglages › Blocages d’un gestionnaire : débloquer un titre, retirer et ajouter un mot-clé', async ({
  page,
  api,
}) => {
  api.state.viewer = viewerAs('manager', 'Camille');
  api.state.blocklist = {
    titles: [blockedTitle(1399, 'Game of Thrones')],
    keywords: [{ id: 210024, name: 'anime' }],
  };
  api.state.keywordResults = [
    { id: 818, name: 'based on novel or book' },
    { id: 9715, name: 'superhero' },
  ];
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(1);
  await expect(page.getByRole('region', { name: /Blocages/ })).toContainText('Game of Thrones');
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Débloquer Game of Thrones' }).click();
  await expect(page.getByText('Game of Thrones')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retirer le mot-clé anime' }).click();
  await expect(page.getByText('Aucun mot-clé bloqué.')).toBeVisible();

  await page.getByLabel('Ajouter un mot-clé TMDB').fill('super');
  const found = page.getByRole('list', { name: 'Mots-clés trouvés' });
  await expect(found.getByRole('listitem')).toHaveCount(1);
  await found.getByRole('button', { name: 'Bloquer le mot-clé superhero' }).click();
  await expect(page.getByRole('button', { name: 'Retirer le mot-clé superhero' })).toBeVisible();
  expect(api.state.blocklist).toEqual({ titles: [], keywords: [{ id: 9715, name: 'superhero' }] });
});

test('Réglages › Règles du propriétaire : masquer les titres disponibles dans Découvrir', async ({ page, api }) => {
  await page.route('**/api/settings/rules', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ json: route.request().postDataJSON() }) : route.fallback(),
  );
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Règles/ }).click();
  const rules = page.getByRole('group', { name: 'Masquer dans Découvrir' });
  await rules.getByRole('checkbox', { name: /Titres disponibles/ }).check();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Règles enregistrées')).toBeVisible();
  expect(api.state.discover).toEqual({ hideAvailable: true, hideRequested: false });
  await expect(page.getByRole('button', { name: /^Blocages/ })).toBeVisible();
});
