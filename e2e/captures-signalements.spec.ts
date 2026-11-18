import { fixtures, mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { mockIssues, quentin, sampleIssues } from './issues-mocks.ts';
import { expect, test, viewerAs } from './support/api.ts';

// Captures de docs/captures/7.4, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures des signalements (7.4)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/7.4';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockCatalogue(page);
  await mockIssues(page, quentin, sampleIssues());

  await page.goto('/signalements');
  await expect(page.getByRole('list', { name: 'Ouverts' }).getByRole('listitem')).toHaveCount(2);
  if (width === 1440) {
    await page.getByRole('button', { name: /Shōgun/ }).click();
    await expect(page.getByRole('complementary', { name: 'Détail du signalement' })).toContainText('épisode 4');
  }
  await settleImages(page);
  await page.screenshot({ path: `${dir}/signalements-${width}.png`, fullPage: width === 1440 });

  if (width === 390) {
    await page.getByRole('button', { name: /Shōgun/ }).tap();
    await expect(page.getByRole('dialog', { name: 'Détail du signalement' })).toBeVisible();
    await settleImages(page);
    await page.screenshot({ path: `${dir}/detail-${width}.png` });
  }

  api.state.viewer = viewerAs('member', 'Camille');
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await page.getByRole('button', { name: 'Signaler un problème' }).click();
  const dialog = page.getByRole('dialog', { name: 'Signaler un problème' });
  await dialog.getByLabel('Saison (facultatif)').selectOption('1');
  await dialog.getByLabel('Épisode (facultatif)').fill('4');
  await dialog.getByLabel('Décrivez le problème').fill('Les sous-titres français sont décalés de plusieurs secondes.');
  await settleImages(page);
  await page.screenshot({ path: `${dir}/feuille-${width}.png` });
});
