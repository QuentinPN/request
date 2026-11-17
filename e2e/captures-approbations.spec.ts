import { mockApprovalQueue } from './requests-mocks.ts';
import { expect, test } from './support/api.ts';

// Captures de docs/captures/4.2, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures de la file d’approbation (4.2)', async ({ page }, { project }) => {
  const dir = 'docs/captures/4.2';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockApprovalQueue(page);
  await page.goto('/approbations');
  if (width === 1440) {
    await page.getByRole('checkbox', { name: 'Sélectionner Conclave' }).check();
    await expect(page.getByText('1 sélectionnée')).toBeVisible();
  } else {
    await expect(page.getByRole('article', { name: 'Conclave' })).toBeVisible();
  }
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/approbations-${width}.png`, fullPage: width === 1440 });

  await page.getByRole('button', { name: /^Échecs/ }).click();
  await expect(page.getByText('dossier /films plein').first()).toBeVisible();
  await page.screenshot({ path: `${dir}/echecs-${width}.png`, fullPage: width === 1440 });
});
