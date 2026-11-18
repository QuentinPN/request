import { membersFixture } from './membres-mocks.ts';
import { expect, test } from './support/api.ts';

// Captures de docs/captures/7.11, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures de Réglages › Membres (7.11)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/7.11';
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.members = membersFixture();
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Membres\b/ }).click();
  await expect(page.getByText('Théo')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-membres-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Déconnecter partout : Marion' }).click();
  await expect(page.getByRole('dialog', { name: 'Déconnecter Marion partout ?' })).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-membres-confirmation-${width}.png` });

  await page.getByRole('button', { name: 'Déconnecter', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-membres-deconnecte-${width}.png`, fullPage: true });
});
