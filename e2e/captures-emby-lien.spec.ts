import { fixtures, mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { embyTest, expect, test } from './support/api.ts';

// Captures de docs/captures/3.3, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures du lien Emby, des décomptes d’épisodes et des webhooks (3.3)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/3.3';
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.embyLink = { kind: 'emby', publicUrl: 'https://emby.exemple.fr', serverId: 'srv-1' };
  api.state.settings.mediaServer = {
    kind: 'emby',
    url: 'http://192.0.2.20:8096',
    apiKey: { set: true },
    libraryIds: ['lib-films', 'lib-series'],
    publicUrl: 'https://emby.exemple.fr',
  };
  await page.route('**/api/setup/mediaServer/test', (route) => route.fulfill({ json: embyTest }));
  await mockCatalogue(page);

  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('link', { name: 'Regarder dans Emby' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-${width}.png`, fullPage: true });

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Tendances' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Regarder Le Robot sauvage dans Emby' })).toBeAttached();
  // L'action des affiches apparaît au survol (toujours visible au toucher) : on survole une affiche disponible.
  await page.getByRole('article').filter({ hasText: 'Le Robot sauvage' }).first().hover();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/affiches-${width}.png` });

  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Serveur multimédia\b/ }).click();
  await expect(page.getByText('Connexion réussie')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-emby-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: /^Serveur multimédia\b/ }).click();
  await page.getByRole('button', { name: /^Webhooks\b/ }).click();
  await expect(page.getByRole('button', { name: 'Régénérer le jeton' })).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-webhooks-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Régénérer le jeton' }).click();
  await expect(page.getByRole('dialog', { name: 'Régénérer le jeton ?' })).toBeVisible();
  await page.screenshot({ path: `${dir}/regenerer-${width}.png` });
});
