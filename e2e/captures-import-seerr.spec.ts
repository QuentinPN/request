import { mockSeerrImport, openSeerrSection, seerrInput } from './import-seerr-mocks.ts';
import { expect, field, test } from './support/api.ts';

// Captures de docs/captures/6.2, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures de l’import Seerr (6.2)', async ({ page }, { project }) => {
  const dir = 'docs/captures/6.2';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockSeerrImport(page);
  await openSeerrSection(page);
  await page.screenshot({ path: `${dir}/import-seerr-vide-${width}.png`, fullPage: true });

  await field(page, 'Adresse de Seerr').fill(seerrInput.url);
  await field(page, 'Clé d’API de Seerr').fill(seerrInput.apiKey);
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(page.getByText('Aperçu : rien n’a encore été importé.')).toBeVisible();
  await page.screenshot({ path: `${dir}/import-seerr-apercu-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importer 35 demandes ?' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${dir}/import-seerr-confirmation-${width}.png` });

  await dialog.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(page.getByText('Import terminé')).toBeVisible();
  await page.screenshot({ path: `${dir}/import-seerr-bilan-${width}.png`, fullPage: true });
});
