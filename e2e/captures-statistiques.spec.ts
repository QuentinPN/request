import { mockStats } from './stats-mocks.ts';
import { expect, test } from './support/api.ts';

// Captures de docs/captures/7.7, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures de la page Statistiques (7.7)', async ({ page }, { project }) => {
  const dir = 'docs/captures/7.7';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockStats(page);
  await page.goto('/statistiques');
  await expect(page.getByRole('region', { name: 'Chiffres clés' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/statistiques-${width}.png`, fullPage: true });

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: `${dir}/statistiques-clair-${width}.png`, fullPage: true });
});
