import type { Page } from '@playwright/test';
import type { ArrServerInput } from '../src/shared/arr-servers.ts';
import type { MediaDetails } from '../src/shared/media.ts';
import { fixtures, mockCatalogue, shogun4k } from './catalogue-mocks.ts';
import { approvalQueue, mockRequests, radarrOptions } from './requests-mocks.ts';
import { arrServer, expect, expectNoAxeViolations, field, test, viewerAs } from './support/api.ts';

// Phase 7.2 : plusieurs serveurs Radarr/Sonarr (Réglages, approbation) et demandes 4K (fiche, feuille de demande).

const radarrSection = (page: Page) => page.getByRole('button', { name: /^Radarr\b/ });
const servers = (page: Page) => page.getByRole('list', { name: 'Serveurs Radarr' });
const sheet = (page: Page) => page.getByRole('dialog');

test('Réglages : la liste des serveurs Radarr, avec la 4K et le serveur par défaut', async ({ page, api }) => {
  api.state.arrServers = [
    arrServer(1, 'radarr'),
    arrServer(3, 'radarr', { name: 'Radarr 4K', url: 'http://192.0.2.21:7878', is4k: true }),
    arrServer(2, 'sonarr'),
  ];
  await page.goto('/reglages');
  await radarrSection(page).click();
  await expect(servers(page).getByRole('listitem')).toHaveCount(2);
  const uhd = servers(page).getByRole('listitem').filter({ hasText: 'Radarr 4K' });
  await expect(uhd).toContainText('4K');
  await expect(uhd).toContainText('Par défaut');
  await expect(uhd).toContainText('http://192.0.2.21:7878');
  await expectNoAxeViolations(page);
});

test('Réglages : ajouter un serveur 4K (testé avant l’enregistrement), puis le supprimer', async ({ page, api }) => {
  let posted: ArrServerInput | undefined;
  await page.route('**/api/arr-servers', (route) => {
    if (route.request().method() === 'POST') posted = route.request().postDataJSON();
    return route.fallback();
  });
  await page.goto('/reglages');
  await radarrSection(page).click();
  await page.getByRole('button', { name: 'Ajouter un serveur Radarr' }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau serveur Radarr' })).toBeVisible();
  await field(page, 'Nom').fill('Radarr 4K');
  await field(page, 'Adresse').fill('http://192.0.2.21:7878');
  await field(page, 'Clé d’API').fill('cle-4k');
  await page.getByRole('checkbox', { name: /Serveur 4K/ }).check();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByText('Connexion réussie · Radarr v4.0.11')).toBeVisible();
  await field(page, 'Profil de qualité').selectOption({ label: 'Ultra-HD' });
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Enregistrer' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Radarr 4K ajouté' })).toBeVisible();
  expect(posted).toMatchObject({
    type: 'radarr',
    name: 'Radarr 4K',
    url: 'http://192.0.2.21:7878',
    apiKey: 'cle-4k',
    is4k: true,
    isDefault: false,
    qualityProfileId: 5,
  });
  // Premier serveur 4K : il devient le serveur par défaut de son couple.
  await expect(servers(page).getByRole('listitem').filter({ hasText: 'Radarr 4K' })).toContainText('Par défaut');

  await page.getByRole('button', { name: 'Supprimer Radarr 4K' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Rien n’est supprimé dans Radarr.');
  await confirm.getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Radarr 4K supprimé' })).toBeVisible();
  await expect(servers(page).getByRole('listitem')).toHaveCount(1);
  expect(api.state.arrServers.map((s) => s.name)).toEqual(['Radarr', 'Sonarr']);
});

test('fiche : « Demander en 4K » ne compte que la version 4K des saisons', async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page, { tv: shogun4k });
  const requests = await mockRequests(page);
  await page.goto(`/titre/tv/${shogun4k.tmdbId}`);
  await page.getByRole('button', { name: 'Demander en 4K' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText('Demander une série en 4K')).toBeVisible();
  const season = (n: number) => dialog.getByRole('checkbox', { name: new RegExp(`^Saison ${n} `) });
  // Saison 1 : disponible en version normale, mais pas en 4K.
  await expect(season(1)).toBeChecked();
  await expect(dialog.getByText('Un administrateur la valide avant l’envoi à Sonarr 4K.')).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Demander 3 saisons en 4K' }).click();
  await expect(dialog.getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'tv', tmdbId: shogun4k.tmdbId, seasons: [1, 2, 3], is4k: true }]);
});

test('feuille ouverte depuis une affiche : choisir la 4K quand un serveur 4K existe', async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page);
  const requests = await mockRequests(page);
  // Flow, sans statut : un Radarr 4K existe (`fourK` présent), rien n'est encore demandé en 4K.
  await page.route('**/api/media/movie/1007', (route) =>
    route.fulfill({ json: { ...fixtures.movie, tmdbId: 1007, title: 'Flow', status: undefined, fourK: {} } }),
  );
  await page.goto('/');
  await page.getByRole('region', { name: 'Tendances' }).getByRole('button', { name: 'Demander Flow' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole('button', { name: 'Standard' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Demander en 4K' }).click();
  await expect(dialog.getByText('Demander un film en 4K')).toBeVisible();
  await expect(dialog.getByText('Un administrateur la valide avant l’envoi à Radarr 4K.')).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Demander ce film en 4K' }).click();
  await expect(dialog.getByText('Demande enregistrée.')).toBeVisible();
  expect(requests.posts).toEqual([{ type: 'movie', tmdbId: 1007, is4k: true }]);
});

test('fiche : pastille 4K, et pas de « Demander en 4K » quand la 4K est déjà là ou sans serveur 4K', async ({
  page,
  api,
}) => {
  api.state.viewer = viewerAs('member');
  const uhd: MediaDetails = {
    ...shogun4k,
    fourK: { status: 'available' },
    seasons: shogun4k.seasons.map((s) => ({ ...s, fourK: { status: 'available' } })),
  };
  await mockCatalogue(page, { tv: uhd });
  await mockRequests(page);
  await page.goto(`/titre/tv/${uhd.tmdbId}`);
  await expect(page.getByText('4K · Disponible').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demander en 4K' })).toHaveCount(0);

  await mockCatalogue(page, { tv: { ...fixtures.tv, status: 'partial' } });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toBeVisible();
  await expect(page.getByText(/^4K ·/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Demander en 4K' })).toHaveCount(0);
});

test('approbation : choisir un autre serveur relit ses listes et l’envoie avec la demande', async ({ page }, {
  project,
}) => {
  test.skip(project.name !== 'ordinateur', 'écran d’ordinateur : panneau de détail');
  const requests = await mockRequests(page);
  requests.requests = approvalQueue();
  requests.sendOptions = {
    movie: {
      ...radarrOptions,
      servers: [...radarrOptions.servers, { id: 5, name: 'Radarr bis', is4k: false, isDefault: false }],
    },
  };
  await page.goto('/approbations');
  const panel = page.getByRole('complementary', { name: 'Détail de la demande' });
  await expect(panel.getByLabel('Serveur Radarr')).toHaveValue('1');
  await panel.getByLabel('Serveur Radarr').selectOption({ label: 'Radarr bis' });
  await expect(panel.getByRole('group', { name: 'Envoyer à Radarr bis' })).toBeVisible();
  expect(requests.optionReads).toContain('movie:5');
  await panel.getByRole('button', { name: 'Approuver et envoyer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'envoyée à' })).toBeVisible();
  expect(requests.approvals).toEqual([{ id: 1, body: { serverId: 5 } }]);
});
