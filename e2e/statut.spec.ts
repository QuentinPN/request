import type { Page } from '@playwright/test';
import { fixtures, mockCatalogue, tvWithEverySeasonStatus } from './catalogue-mocks.ts';
import { expect, expectNoAxeViolations, test } from './support/api.ts';

const trending = fixtures.discover.rows.find((row) => row.id === 'trending')?.items ?? [];
const [partial, available, downloading, requested, pending, declined, absent] = trending;

/** Affiche d'une rangée, trouvée par son titre ; la pastille et la barre vivent dans le même `article`. */
const posterOf = (page: Page, title: string | undefined) =>
  page
    .getByRole('region', { name: 'Tendances' })
    .getByRole('article')
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${title}`) }) });

test('les affiches montrent le statut : pastille, barre de téléchargement, rien sans statut', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'À la une' })).toBeVisible();

  const expected = [
    [partial, 'Partiel'],
    [available, 'Disponible'],
    [downloading, '42 %'],
    [requested, 'Demandé'],
    [pending, 'En attente'],
    [declined, 'Refusé'],
  ] as const;
  for (const [media, label] of expected) {
    await expect(posterOf(page, media?.title).locator('[data-status]')).toHaveText(label);
  }
  await expect(posterOf(page, absent?.title).locator('[data-status]')).toHaveCount(0);

  const bar = posterOf(page, downloading?.title).getByRole('progressbar');
  await expect(bar).toHaveAccessibleName(`Téléchargement de ${downloading?.title}`);
  await expect(bar).toHaveAttribute('aria-valuenow', '42');
  await expect(page.getByRole('progressbar')).toHaveCount(1);
  await expectNoAxeViolations(page);
});

test('« Ajoutés récemment dans Emby » est une rangée comme les autres', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/');
  const row = page.getByRole('region', { name: 'Ajoutés récemment dans Emby' });
  await expect(row.getByRole('heading', { level: 2 })).toBeVisible();
  const recent = fixtures.discover.rows.find((r) => r.id === 'emby-recent')?.items ?? [];
  await expect(row.getByRole('article')).toHaveCount(recent.length);
  await expect(row.locator('[data-status="available"]')).toHaveCount(recent.length);
});

test('le hero reprend la pastille du titre ; un titre complet n’a plus de « Demander »', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/');
  const une = page.getByRole('region', { name: 'À la une' });
  await expect(une.locator('[data-status]')).toHaveText('Partiel');
  await expect(une.getByRole('button', { name: 'Demander' })).toBeVisible();

  const [first, ...others] = trending;
  await page.route('**/api/discover', (route) =>
    route.fulfill({
      json: {
        rows: [{ id: 'trending', title: 'Tendances', items: [{ ...first, status: 'available' }, ...others] }],
      },
    }),
  );
  await page.reload();
  await expect(une.locator('[data-status]')).toHaveText('Disponible');
  await expect(une.getByRole('button', { name: 'Demander' })).toHaveCount(0);
});

test('la recherche affiche le statut de chaque résultat', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/demandes');
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.type('sho');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(fixtures.search.results.length);
  await expect(options.nth(0).locator('[data-status]')).toHaveText('Disponible');
  await expect(options.nth(1).locator('[data-status]')).toHaveText('En téléchargement');
  await expect(options.nth(2).locator('[data-status]')).toHaveCount(0);
});

test('la fiche d’une série montre le statut du titre et de chaque saison', async ({ page }) => {
  await mockCatalogue(page, { tv: tvWithEverySeasonStatus });
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();
  await expect(page.getByRole('article').locator('[data-status]').first()).toHaveText('Partiel');

  const saisons = page.getByRole('region', { name: 'Saisons' });
  const season = (n: number) => saisons.getByRole('listitem').nth(n - 1);
  await expect(season(1).locator('[data-status]')).toHaveText('Disponible');
  await expect(season(2).locator('[data-status]')).toHaveText('Partiel');
  await expect(season(3).locator('[data-status]')).toHaveText('En téléchargement');
  await expect(season(4).locator('[data-status]')).toHaveCount(0);

  const bar = saisons.getByRole('progressbar');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAccessibleName('Téléchargement de Saison 3');
  await expect(bar).toHaveAttribute('aria-valuenow', '42');
  await expectNoAxeViolations(page);
});
