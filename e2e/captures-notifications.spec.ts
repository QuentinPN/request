import { mockCatalogue } from './catalogue-mocks.ts';
import { mockNotifications } from './notifications-mocks.ts';
import { expect, test } from './support/api.ts';

// Captures de docs/captures/5.2, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures des notifications (5.2)', async ({ page }, { project }) => {
  const dir = 'docs/captures/5.2';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockCatalogue(page);
  await mockNotifications(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/cloche-${width}.png` });

  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await page.screenshot({ path: `${dir}/panneau-${width}.png` });
});
