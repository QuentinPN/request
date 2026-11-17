import { mockSeerrImport, openSeerrSection, seerrInput } from './import-seerr-mocks.ts';
import { expect, expectNoAxeViolations, field, test } from './support/api.ts';

const section = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: /^Importer depuis Seerr\b/ });

test('Prévisualiser montre les comptes, Importer demande confirmation puis montre le bilan', async ({ page }) => {
  const calls = await mockSeerrImport(page);
  await page.goto('/reglages');
  await expect(page.getByRole('button', { name: /^Importer depuis Seerr\b/ })).toContainText('Facultatif');
  await openSeerrSection(page);
  const importButton = section(page).getByRole('button', { name: 'Importer', exact: true });
  await expect(importButton).toBeDisabled();
  await expectNoAxeViolations(page);

  await field(page, 'Adresse de Seerr').fill(seerrInput.url);
  await field(page, 'Clé d’API de Seerr').fill(seerrInput.apiKey);
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(section(page)).toContainText('Aperçu : rien n’a encore été importé.');
  await expect(section(page)).toContainText('42 demandes lues dans Seerr.');
  await expect(section(page).getByText('À importer')).toBeVisible();
  await expect(section(page)).toContainText('Mamie · 2 demandes');
  expect(calls).toEqual([{ dryRun: true, body: seerrInput }]);
  await expectNoAxeViolations(page);

  // Annuler : rien d'importé.
  await importButton.click();
  const dialog = page.getByRole('dialog', { name: 'Importer 35 demandes ?' });
  await expect(dialog).toContainText('Rien n’est envoyé à Radarr ni à Sonarr');
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls).toHaveLength(1);

  await importButton.click();
  await dialog.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls[1]).toEqual({ dryRun: false, body: seerrInput });
  await expect(section(page)).toContainText('Import terminé : 35 demandes créées.');
  await expect(section(page).getByText('Importées')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Importer depuis Seerr\b/ })).toContainText('Importé');
  // La clé ne reste pas dans le champ ; il faut prévisualiser à nouveau pour réimporter.
  await expect(field(page, 'Clé d’API de Seerr')).toHaveValue('');
  await expect(importButton).toBeDisabled();
  await expectNoAxeViolations(page);
});

test('une modification efface l’aperçu ; adresse invalide et refus de Seerr restent lisibles', async ({ page }) => {
  await mockSeerrImport(page, { error: 'Clé d’API refusée par Seerr' });
  await openSeerrSection(page);
  await field(page, 'Adresse de Seerr').fill('seerr.local');
  await field(page, 'Clé d’API de Seerr').fill(seerrInput.apiKey);
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(section(page)).toContainText('Adresse invalide');

  await field(page, 'Adresse de Seerr').fill(seerrInput.url);
  await expect(section(page)).not.toContainText('Adresse invalide');
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(section(page)).toContainText('Clé d’API refusée par Seerr');
  await expect(page.getByRole('button', { name: /^Importer depuis Seerr\b/ })).toContainText('Erreur');
  await expect(section(page).getByRole('button', { name: 'Importer', exact: true })).toBeDisabled();
  await expectNoAxeViolations(page);
});
