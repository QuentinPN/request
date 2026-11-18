import { fixtures, mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { mockPlexPin, plexTest, signedOutWith } from './media-server-mocks.ts';
import { expect, field, fillSetupToken, freshSetup, test } from './support/api.ts';

// Captures de docs/captures/7.3, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

const dir = 'docs/captures/7.3';

test('captures de la connexion Plex et Jellyfin (7.3)', async ({ page, context, api }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  signedOutWith(api, 'plex');
  await mockPlexPin(page, context, api);
  await page.goto('/connexion');
  await expect(page.getByRole('button', { name: 'Se connecter avec Plex' })).toBeVisible();
  await page.screenshot({ path: `${dir}/connexion-plex-${width}.png`, fullPage: true });

  const popupOpened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Se connecter avec Plex' }).click();
  await (await popupOpened).close();
  await expect(page.getByRole('status')).toContainText('En attente de Plex…');
  await page.screenshot({ path: `${dir}/connexion-plex-attente-${width}.png`, fullPage: true });

  signedOutWith(api, 'jellyfin');
  await page.goto('/connexion');
  await expect(page.getByRole('form', { name: 'Connexion avec votre compte Jellyfin' })).toBeVisible();
  await page.screenshot({ path: `${dir}/connexion-jellyfin-${width}.png`, fullPage: true });
});

test('captures du choix du type de serveur (7.3)', async ({ page, api }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.setup = structuredClone(freshSetup);
  api.state.viewer = null;
  await page.route('**/api/setup/mediaServer/test', (route) => route.fulfill({ json: plexTest }));
  await page.goto('/assistant');
  await expect(page.getByRole('group', { name: 'Type de serveur' })).toBeVisible();
  await page.screenshot({ path: `${dir}/assistant-type-${width}.png`, fullPage: true });

  await page.getByRole('radio', { name: /^Plex/ }).check();
  await field(page, 'Adresse').fill('http://192.0.2.20:32400');
  await field(page, 'Jeton Plex du propriétaire').fill('jeton-plex');
  await fillSetupToken(page);
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByText('Connexion réussie')).toBeVisible();
  await page.screenshot({ path: `${dir}/assistant-plex-${width}.png`, fullPage: true });
});

test('captures de Réglages et de la fiche avec Plex (7.3)', async ({ page, api }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.setup = { ...api.state.setup, mediaServerKind: 'plex' };
  api.state.embyLink = { kind: 'plex', serverId: 'machine-1', publicUrl: null };
  api.state.settings.mediaServer = {
    kind: 'plex',
    url: 'http://192.0.2.20:32400',
    apiKey: { set: true },
    libraryIds: ['lib-films', 'lib-series'],
    publicUrl: null,
  };
  await page.route('**/api/setup/mediaServer/test', (route) => route.fulfill({ json: plexTest }));
  await mockCatalogue(page);

  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Serveur multimédia\b/ }).click();
  await expect(page.getByText('Le type ne peut plus changer')).toBeVisible();
  await expect(page.getByText('Connexion réussie')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-plex-${width}.png`, fullPage: true });

  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('link', { name: 'Regarder dans Plex' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-plex-${width}.png`, fullPage: true });
});
