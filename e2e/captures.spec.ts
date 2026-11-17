import type { Page } from '@playwright/test';
import { fixtures, mockCatalogue } from './catalogue-mocks.ts';
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

/** Attend que toutes les images chargées paresseusement de la page entière soient décodées. */
async function settleImages(page: Page) {
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = 'eager';
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    await document.fonts.ready;
  });
}

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
