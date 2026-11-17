import { expect, test } from '@playwright/test';

// Captures de docs/captures/1.4, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

const dir = 'docs/captures/1.4';

test('captures du shell', async ({ page }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.screenshot({ path: `${dir}/decouvrir-${width}.png` });
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Rechercher' })).toBeVisible();
  await page.screenshot({ path: `${dir}/recherche-${width}.png` });
});
