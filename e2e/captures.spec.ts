import { fixtures, mockCatalogue, settleImages, tvWithEverySeasonStatus } from './catalogue-mocks.ts';
import { makeRequest, mediaNamed, mockRequests } from './requests-mocks.ts';
import { expect, field, sonarrTest, test, viewerAs } from './support/api.ts';

// Captures de docs/captures, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

const widthOf = (project: { name: string }) => (project.name === 'mobile' ? 390 : 1440);

test('captures du shell', async ({ page }, { project }) => {
  const dir = 'docs/captures/1.4';
  const width = widthOf(project);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.screenshot({ path: `${dir}/decouvrir-${width}.png` });
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Rechercher' })).toBeVisible();
  await page.screenshot({ path: `${dir}/recherche-${width}.png` });
});

test('captures de la connexion et de l’assistant (2.2)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/2.2';
  const width = widthOf(project);
  api.state.viewer = null;
  await page.goto('/connexion');
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await page.screenshot({ path: `${dir}/connexion-${width}.png` });

  // Comme la maquette R-Assistant : Emby, TMDB et Radarr testés, Sonarr ouvert et testé.
  api.state.viewer = viewerAs('owner');
  api.state.setup = {
    services: { emby: true, tmdb: true, radarr: true, sonarr: false, rules: false },
    hasOwner: true,
    complete: false,
  };
  await page.route('**/api/setup/sonarr/test', (route) => route.fulfill({ json: sonarrTest }));
  await page.goto('/assistant');
  await field(page, 'Adresse').fill('http://192.0.2.20:8989');
  await field(page, 'Clé d’API').fill('4f2a9c1e8b7d4f2a');
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByText('Connexion réussie · Sonarr v4.0.11')).toBeVisible();
  await page.screenshot({ path: `${dir}/assistant-${width}.png`, fullPage: true });
});

test('captures des pastilles de statut (3.2)', async ({ page }, { project }) => {
  const dir = 'docs/captures/3.2';
  const width = widthOf(project);
  await mockCatalogue(page, { tv: tvWithEverySeasonStatus });

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'À la une' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/decouvrir-${width}.png`, fullPage: true });

  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-tv-${width}.png`, fullPage: true });
});

test('captures du catalogue (3.1)', async ({ page }, { project }) => {
  const dir = 'docs/captures/3.1';
  const width = widthOf(project);
  await mockCatalogue(page);

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'À la une' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/decouvrir-${width}.png`, fullPage: true });

  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-${width}.png`, fullPage: true });

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('sho');
  await expect(page.getByRole('option').first()).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/recherche-${width}.png` });
});

test('captures des demandes (4.3)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/4.3';
  const width = widthOf(project);
  api.state.viewer = viewerAs('member');
  const shogun = {
    ...fixtures.tv,
    seasons: [
      { seasonNumber: 1, episodeCount: 10, airDate: '2024-02-27', status: 'available' as const },
      { seasonNumber: 2, episodeCount: 10, airDate: '2025-02-27' },
      { seasonNumber: 3, episodeCount: 8, airDate: '2099-01-01' },
    ],
  };
  await mockCatalogue(page, { tv: shogun });
  const requests = await mockRequests(page);

  // Feuille de demande d'une série (maquettes A-Demande et R-Mobile).
  await page.goto(`/titre/tv/${shogun.tmdbId}`);
  await page.getByRole('button', { name: 'Demander', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox').first()).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/feuille-${width}.png` });

  requests.requests = [
    makeRequest(mediaNamed('Conclave'), 'sent', { events: ['requested', 'approved', 'sent'] }),
    makeRequest(mediaNamed('Shōgun'), 'sent', { seasons: [2], events: ['requested', 'approved', 'sent'], day: 12 }),
    makeRequest(mediaNamed('Gladiator II'), 'pending', { day: 11 }),
    makeRequest(mediaNamed('Le Robot sauvage'), 'available', { day: 9 }),
    makeRequest(mediaNamed('Arcane'), 'declined', { seasons: [1, 2], declineReason: 'Déjà sur le disque', day: 8 }),
  ];

  await page.goto('/demandes');
  await page.getByRole('button', { name: /^Toutes/ }).click();
  await expect(page.getByRole('list', { name: 'Demandes : toutes' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/demandes-${width}.png`, fullPage: true });

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Vos demandes en cours' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/decouvrir-${width}.png`, fullPage: true });

  await page.goto(`/titre/tv/${shogun.tmdbId}`);
  await expect(page.getByRole('region', { name: 'Suivi de la demande' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-suivi-${width}.png`, fullPage: true });
});
