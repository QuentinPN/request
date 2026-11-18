import { mockStats } from './stats-mocks.ts';
import { expect, test } from './support/api.ts';

// Captures de docs/captures/nav, hors `npm run verify` : « Retour » et navigation active sur une page ouverte depuis Compte.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures du bouton Retour sur Statistiques (nav)', async ({ page }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockStats(page);
  await page.goto('/compte');
  await page.getByRole('link', { name: /^Statistiques/ }).click();
  await expect(page.getByRole('region', { name: 'Chiffres clés' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `docs/captures/nav/statistiques-retour-${width}.png` });
});
