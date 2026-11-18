import { membersFixture } from './membres-mocks.ts';
import { makeRequest, mediaNamed, mockRequests, person } from './requests-mocks.ts';
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

// Modifier un membre et voir ses demandes : docs/captures/membres, mêmes réglages.
test('captures de la modification d’un membre et de ses demandes', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/membres';
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.members = membersFixture();
  const requests = await mockRequests(page);
  requests.requests = [
    makeRequest(mediaNamed('Gladiator II'), 'pending', { requester: person('Marion') }),
    makeRequest(mediaNamed('Conclave'), 'sent', { requester: person('Théo') }),
    makeRequest(mediaNamed('Le Robot sauvage'), 'available', { requester: person('Marion'), day: 8 }),
    makeRequest(mediaNamed('Flow'), 'pending'),
  ];
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Membres\b/ }).click();
  await expect(page.getByText('Théo')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-membres-actions-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Modifier : Théo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Modifier Théo' });
  await dialog.getByRole('radio', { name: /^Quotas propres/ }).check();
  await dialog.getByLabel('Nombre de films').fill('3');
  await page.screenshot({ path: `${dir}/modifier-membre-${width}.png` });
  await dialog.getByRole('radio', { name: /^Gestionnaire/ }).check();
  await page.screenshot({ path: `${dir}/modifier-membre-gestionnaire-${width}.png` });
  await dialog.getByRole('button', { name: 'Annuler' }).click();

  await page.getByRole('link', { name: 'Voir ses demandes : Marion' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes de Marion' })).toBeVisible();
  await expect(page.getByText('Gladiator II')).toBeVisible();
  await page.screenshot({ path: `${dir}/demandes-membre-${width}.png`, fullPage: true });
});
