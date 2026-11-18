import { mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { expect, test } from './support/api.ts';
import { openMoreMenu } from './support/nav.ts';

// Captures de docs/captures/7.10, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

const dir = 'docs/captures/7.10';

test('captures de la navigation (7.10)', async ({ page }, { project }) => {
  await mockCatalogue(page);
  await page.route('**/api/requests/counts', (route) =>
    route.fulfill({ json: { pendingApprovals: 3, mineActive: 1 } }),
  );
  await page.route('**/api/issues/counts', (route) => route.fulfill({ json: { open: 2 } }));

  if (project.name === 'mobile') {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settleImages(page);
    await page.screenshot({ path: `${dir}/navigation-390.png` });
    await page.goto('/compte');
    await expect(page.getByRole('heading', { level: 1, name: 'Compte' })).toBeVisible();
    await page.screenshot({ path: `${dir}/compte-390.png` });
    return;
  }

  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settleImages(page);
    await page.screenshot({ path: `${dir}/navigation-${width}.png` });
    await openMoreMenu(page);
    await page.screenshot({ path: `${dir}/menu-plus-${width}.png` });
  }
});
