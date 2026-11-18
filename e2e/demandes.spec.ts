import type { Page } from '@playwright/test';
import type { MediaDetails } from '../src/shared/media.ts';
import { fixtures, mockCatalogue } from './catalogue-mocks.ts';
import { makeRequest, mediaNamed, mockRequests, quotaOf } from './requests-mocks.ts';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';

/** Shōgun : saison 1 disponible, 2 et 3 diffusées et absentes, 4 annoncée. */
const shogun: MediaDetails = {
  ...fixtures.tv,
  status: 'partial',
  seasons: [
    { seasonNumber: 1, episodeCount: 10, airDate: '2024-02-27', status: 'available' },
    { seasonNumber: 2, episodeCount: 10, airDate: '2025-02-27' },
    { seasonNumber: 3, episodeCount: 8, airDate: '2026-02-27' },
    { seasonNumber: 4, episodeCount: 0, airDate: '2099-01-01' },
  ],
};

const sheet = (page: Page) => page.getByRole('dialog');

/** Ouvre la feuille depuis l'affiche de Flow (film sans statut) dans Tendances. */
async function openFlowSheet(page: Page) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Tendances' }).getByRole('button', { name: 'Demander Flow' }).click();
  await expect(sheet(page).getByRole('heading', { name: 'Flow' })).toBeVisible();
}

test.beforeEach(async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page, { tv: shogun });
});

test('demander un film en deux clics depuis une affiche, le catalogue est relu', async ({ page }) => {
  const requests = await mockRequests(page);
  await openFlowSheet(page);
  await expect(sheet(page).getByText('il vous reste')).toContainText('7 films');
  const reload = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/discover');
  await sheet(page).getByRole('button', { name: 'Demander ce film' }).click();
  await expect(sheet(page).getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'movie', tmdbId: 1007 }]);
  await reload;
  await expectNoAxeViolations(page);
});

test('demander une série : saisons manquantes présélectionnées, les autres grisées', async ({ page }) => {
  const requests = await mockRequests(page);
  await page.goto(`/titre/tv/${shogun.tmdbId}`);
  await page.getByRole('button', { name: 'Demander', exact: true }).click();
  const dialog = sheet(page);
  const season = (n: number) => dialog.getByRole('checkbox', { name: new RegExp(`^Saison ${n} `) });
  await expect(dialog.getByRole('checkbox', { name: 'Toutes les saisons manquantes' })).toBeChecked();
  await expect(season(1)).toBeDisabled();
  await expect(season(2)).toBeChecked();
  await expect(season(3)).toBeChecked();
  await expect(season(4)).toBeDisabled();
  await expect(dialog.getByText('Pas encore diffusée')).toBeVisible();
  await expectNoAxeViolations(page);

  await season(3).uncheck();
  await dialog.getByRole('button', { name: 'Demander 1 saison' }).click();
  await expect(dialog.getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'tv', tmdbId: shogun.tmdbId, seasons: [2] }]);
});

test('quota atteint : message et bouton désactivé ; refus du serveur affiché tel quel', async ({ page }) => {
  const requests = await mockRequests(page);
  requests.quota = quotaOf(0, 3);
  await openFlowSheet(page);
  await expect(sheet(page).getByRole('alert')).toContainText('Quota atteint');
  await expect(sheet(page).getByRole('button', { name: 'Demander ce film' })).toBeDisabled();

  requests.quota = quotaOf(2, 3);
  requests.createError = { status: 409, error: 'Ce titre est déjà demandé' };
  await openFlowSheet(page);
  await sheet(page).getByRole('button', { name: 'Demander ce film' }).click();
  await expect(sheet(page).getByRole('alert')).toHaveText('Ce titre est déjà demandé');
});

test('exempté de quota : aucun quota affiché', async ({ page, api }) => {
  api.state.viewer = viewerAs('owner');
  const requests = await mockRequests(page);
  requests.quota = { ...quotaOf(0, 0), exempt: true };
  await openFlowSheet(page);
  await expect(sheet(page).getByText('Elle part directement à Radarr.')).toBeVisible();
  await expect(sheet(page).getByText(/quota/i)).toHaveCount(0);
  await expect(sheet(page).getByRole('button', { name: 'Demander ce film' })).toBeEnabled();
});

test('double clic sur « Demander » : une seule demande envoyée', async ({ page }) => {
  const requests = await mockRequests(page);
  await openFlowSheet(page);
  await sheet(page).getByRole('button', { name: 'Demander ce film' }).dblclick();
  await expect(sheet(page).getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toHaveLength(1);
});

test('Mes demandes : filtres avec compteurs, motif de refus, annulation confirmée', async ({ page }) => {
  const requests = await mockRequests(page);
  requests.requests = [
    makeRequest(mediaNamed('Gladiator II'), 'pending'),
    makeRequest(mediaNamed('Conclave'), 'sent'),
    makeRequest(mediaNamed('Le Robot sauvage'), 'available'),
    makeRequest(mediaNamed('Arcane'), 'declined', { seasons: [1, 2], declineReason: 'Déjà sur le disque partagé' }),
    makeRequest(mediaNamed('Flow'), 'cancelled'),
  ];
  await page.goto('/demandes');
  await expect(page.getByRole('heading', { level: 1, name: 'Mes demandes' })).toBeVisible();
  const chip = (name: RegExp) => page.getByRole('button', { name });
  await expect(chip(/^En cours 2$/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(/^Disponibles 1$/)).toBeVisible();
  await expect(chip(/^Refusées 1$/)).toBeVisible();
  await expect(chip(/^Toutes 5$/)).toBeVisible();
  const rows = page
    .getByRole('list', { name: /^Demandes/ })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link') });
  await expect(rows).toHaveCount(2);
  // Conclave est en téléchargement (42 %) : troisième étape en cours.
  await expect(rows.nth(1).getByText('Téléchargement à 42 %')).toBeVisible();
  await expectNoAxeViolations(page);

  await chip(/^Refusées/).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Série · saisons 1 et 2');
  await expect(rows.first()).toContainText('Motif : Déjà sur le disque partagé');

  await chip(/^En cours/).click();
  await rows.first().getByRole('button', { name: 'Annuler la demande de Gladiator II' }).click();
  const confirm = page.getByRole('dialog', { name: 'Annuler la demande de Gladiator II ?' });
  await confirm.getByRole('button', { name: 'Annuler la demande' }).click();
  await expect(confirm).toBeHidden();
  await expect(rows).toHaveCount(1);
  await expect(chip(/^En cours 1$/)).toBeVisible();
});

test('Mes demandes : « Charger plus » affiche les suivantes', async ({ page }) => {
  const requests = await mockRequests(page);
  requests.requests = Array.from({ length: 25 }, () => makeRequest(mediaNamed('Flow'), 'available'));
  await page.goto('/demandes');
  const rows = page
    .getByRole('list', { name: /^Demandes/ })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link') });
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'Charger plus' }).click();
  await expect(rows).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'Charger plus' })).toHaveCount(0);
});

test('Découvrir : « Vos demandes en cours » seulement avec une demande en cours, trois cartes au plus', async ({
  page,
}) => {
  const requests = await mockRequests(page);
  requests.requests = [makeRequest(mediaNamed('Flow'), 'available')];
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Tendances' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Vos demandes en cours' })).toHaveCount(0);

  requests.requests = [
    makeRequest(mediaNamed('Gladiator II'), 'pending'),
    makeRequest(mediaNamed('Conclave'), 'sent'),
    makeRequest(mediaNamed('Shōgun'), 'approved', { seasons: [1] }),
    makeRequest(mediaNamed('Severance'), 'pending', { seasons: [1, 2] }),
  ];
  await page.reload();
  const strip = page.getByRole('region', { name: 'Vos demandes en cours' });
  await expect(strip.getByRole('listitem').filter({ has: page.getByRole('link') })).toHaveCount(3);
  await expect(strip.getByRole('link', { name: 'Shōgun · S1' })).toBeVisible();
  await strip.getByRole('link', { name: 'Mes demandes' }).click();
  await expect(page).toHaveURL(/\/demandes$/);
});

test('fiche : « Suivi de la demande » avec dates, auteurs et étape actuelle', async ({ page }) => {
  const requests = await mockRequests(page);
  requests.requests = [
    makeRequest(mediaNamed('Shōgun'), 'sent', { seasons: [2, 3], events: ['requested', 'approved', 'sent'] }),
  ];
  await page.goto(`/titre/tv/${shogun.tmdbId}`);
  const suivi = page.getByRole('region', { name: 'Suivi de la demande' });
  const steps = suivi.getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(0)).toContainText('Demandée par Quentin');
  await expect(steps.nth(0)).toContainText('13 nov. à 20 h 02');
  await expect(steps.nth(1)).toContainText('Approuvée par Quentin');
  await expect(steps.nth(2)).toContainText('Envoyée à Sonarr');
  await expect(steps.nth(3)).toHaveAttribute('aria-current', 'step');
  await expect(steps.nth(3)).toContainText('Recherche d’une source');
  await expect(steps.nth(5)).toContainText('Dans Emby');
  await expectNoAxeViolations(page);
});

test('fiche : pas de suivi sans demande du membre pour ce titre', async ({ page }) => {
  const requests = await mockRequests(page);
  requests.requests = [makeRequest(mediaNamed('Flow'), 'pending')];
  await page.goto(`/titre/tv/${shogun.tmdbId}`);
  await expect(page.getByRole('region', { name: 'Où regarder' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Suivi de la demande' })).toHaveCount(0);
});

test('série dont la saison 1 est déjà envoyée : « Demander » reste là, la saison 1 grisée, seule la 2 se demande', async ({
  page,
}) => {
  const requests = await mockRequests(page);
  const sent: MediaDetails = {
    ...shogun,
    status: 'requested',
    seasons: [
      { seasonNumber: 1, episodeCount: 10, airDate: '2024-02-27', status: 'requested' },
      { seasonNumber: 2, episodeCount: 10, airDate: '2025-02-27' },
    ],
  };
  await mockCatalogue(page, { tv: sent });
  requests.requests = [
    makeRequest(mediaNamed('Shōgun'), 'sent', { seasons: [1], events: ['requested', 'approved', 'sent'] }),
  ];
  await page.goto(`/titre/tv/${sent.tmdbId}`);
  await page.getByRole('button', { name: 'Demander', exact: true }).click();
  const dialog = sheet(page);
  const season = (n: number) => dialog.getByRole('checkbox', { name: new RegExp(`^Saison ${n} `) });
  await expect(season(1)).toBeDisabled();
  await expect(season(2)).toBeChecked();
  await dialog.getByRole('button', { name: 'Demander 1 saison' }).click();
  await expect(dialog.getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'tv', tmdbId: sent.tmdbId, seasons: [2] }]);
});

test('série dont toutes les saisons sont disponibles ou demandées : pas de « Demander »', async ({ page }) => {
  await mockRequests(page);
  const covered: MediaDetails = {
    ...shogun,
    status: 'requested',
    seasons: [
      { seasonNumber: 1, episodeCount: 10, airDate: '2024-02-27', status: 'available' },
      { seasonNumber: 2, episodeCount: 10, airDate: '2025-02-27', status: 'requested' },
    ],
  };
  await mockCatalogue(page, { tv: covered });
  await page.goto(`/titre/tv/${covered.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: covered.title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toHaveCount(0);
});

test('série dont la saison 1 est approuvée pour le membre : message à la place de « Demander »', async ({ page }) => {
  const requests = await mockRequests(page);
  const approved: MediaDetails = {
    ...shogun,
    status: 'requested',
    seasons: [
      { seasonNumber: 1, episodeCount: 10, airDate: '2024-02-27', status: 'requested' },
      { seasonNumber: 2, episodeCount: 10, airDate: '2025-02-27' },
    ],
  };
  await mockCatalogue(page, { tv: approved });
  requests.requests = [makeRequest(mediaNamed('Shōgun'), 'approved', { seasons: [1] })];
  await page.goto(`/titre/tv/${approved.tmdbId}`);
  await expect(page.getByText('Votre demande précédente est en cours de traitement', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toHaveCount(0);
});
