import type { Stats } from '../src/shared/stats.ts';
import { mockStats, sampleStats } from './stats-mocks.ts';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';
import { openMoreMenu } from './support/nav.ts';

const emptyStats: Stats = {
  requests: {
    total: 0,
    byStatus: { pending: 0, approved: 0, declined: 0, cancelled: 0, sent: 0, failed: 0, available: 0 },
    byMonth: sampleStats.requests.byMonth.map(({ month }) => ({ month, count: 0 })),
    byType: { movie: 0, tv: 0 },
    byQuality: { standard: 0, fourK: 0 },
  },
  topMembers: [],
  topTitles: [],
  delays: {
    approval: { samples: 0, medianSeconds: null, meanSeconds: null },
    availability: { samples: 0, medianSeconds: null, meanSeconds: null },
  },
  issues: { open: 0, resolved: 0 },
  members: 1,
  watchlist: { entries: 0, titles: 0 },
};

test('les chiffres clés, l’histogramme et les classements s’affichent', async ({ page }) => {
  await mockStats(page);
  await page.goto('/statistiques');
  await expect(page.getByRole('heading', { level: 1, name: 'Statistiques' })).toBeVisible();

  const tiles = page.getByRole('region', { name: 'Chiffres clés' });
  await expect(tiles.getByText('214')).toBeVisible();
  await expect(tiles.getByText('3', { exact: true })).toBeVisible(); // signalements ouverts
  await expect(tiles.getByText('12 résolus')).toBeVisible();
  await expect(tiles.getByText('1,5 h')).toBeVisible(); // médiane d'approbation
  await expect(tiles.getByText('Moyenne 6 h · 138 demandes')).toBeVisible();
  await expect(tiles.getByText('25 h')).toBeVisible(); // médiane de mise à disposition

  const months = page.getByRole('list', { name: 'Demandes par mois' });
  await expect(months.getByRole('listitem')).toHaveCount(12);
  await expect(months.getByRole('listitem').nth(5)).toHaveAttribute('title', 'mai 2026 : 26');
  await expect(months.getByRole('listitem').nth(2)).toHaveAttribute('title', 'février 2026 : 0');

  const members = page.getByRole('list', { name: 'Membres les plus actifs' });
  await expect(members.getByRole('listitem').first()).toContainText('Marion');
  await expect(members.getByRole('listitem').first()).toContainText('52');
  const titles = page.getByRole('list', { name: 'Titres les plus demandés' });
  await expect(titles.getByRole('link', { name: /Matrix/ })).toHaveAttribute('href', '/titre/movie/603');
  await expect(titles.getByRole('link', { name: 'Film n° 98765' })).toBeVisible(); // titre inconnu de TMDB
});

test('chaque graphique a son tableau de chiffres', async ({ page }) => {
  await mockStats(page);
  await page.goto('/statistiques');
  const table = page.getByRole('table', { name: 'Demandes par mois' });
  await expect(table).toBeHidden();
  await page.getByText('Voir les chiffres').first().click();
  await expect(table.getByRole('row')).toHaveCount(13); // en-tête + 12 mois
  await expect(table.getByRole('row', { name: /février 2026/ })).toContainText('0');
});

test('sans demande, la page reste lisible', async ({ page }) => {
  await mockStats(page, emptyStats);
  await page.goto('/statistiques');
  await expect(page.getByText('Aucun titre n’a encore été demandé.')).toBeVisible();
  await expect(page.getByText('Aucun membre n’a encore fait de demande.')).toBeVisible();
  await expect(page.getByText('Pas encore de mesure').first()).toBeVisible();
  await expectNoAxeViolations(page);
});

test('accessibilité sur une page remplie, en clair comme en sombre', async ({ page }) => {
  await mockStats(page);
  await page.goto('/statistiques');
  await expect(page.getByRole('region', { name: 'Chiffres clés' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await expectNoAxeViolations(page);
});

test('un membre sans le droit ne voit ni l’entrée de navigation ni les chiffres', async ({ page, api }, {
  project,
}) => {
  api.state.viewer = viewerAs('member');
  await mockStats(page, sampleStats, 403);
  await page.goto('/statistiques');
  await expect(page.getByText('Accès réservé')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Statistiques' })).toHaveCount(0);
  if (project.name === 'mobile') return;
  await expect(await openMoreMenu(page)).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Statistiques' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Ma liste' })).toBeVisible();
});

test('mobile : la page s’ouvre depuis Compte, sans défilement horizontal', async ({ page, api }, { project }) => {
  test.skip(project.name !== 'mobile', 'barre d’onglets du mobile');
  api.state.viewer = viewerAs('manager');
  await mockStats(page);
  await page.goto('/compte');
  await page.getByRole('link', { name: 'Statistiques' }).click();
  await expect(page).toHaveURL(/\/statistiques$/);
  await expect(page.getByRole('region', { name: 'Chiffres clés' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
