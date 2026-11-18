import { fixtures, mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { makeRequest, memberNamed, mockApprovalQueue, person, stubMedia } from './requests-mocks.ts';
import { expect, test, viewerAs } from './support/api.ts';

// Captures de docs/captures/7.9, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures des ajustements des demandes (7.9)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/7.9';
  const width = project.name === 'mobile' ? 390 : 1440;

  // Feuille d'un gestionnaire : demande pour Marion, hors quota.
  api.state.viewer = viewerAs('manager', 'Camille');
  api.state.members = [memberNamed('Marion'), memberNamed('Marius'), memberNamed('Théo')];
  const requests = await mockApprovalQueue(page);
  requests.requests[0] = makeRequest(stubMedia(1001, 'Conclave'), 'pending', {
    id: 1,
    requester: person('Marion'),
    createdBy: person('Camille'),
  });
  await mockCatalogue(page);
  await page.goto('/');
  await page.getByRole('region', { name: 'Tendances' }).getByRole('button', { name: 'Demander Flow' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Rechercher un membre').fill('mar');
  await sheet.getByRole('radio', { name: 'Marion' }).check();
  await sheet.getByRole('checkbox', { name: /Hors quota/ }).check();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/feuille-pour-un-membre-${width}.png` });
  await page.keyboard.press('Escape');

  // File d'approbation : « Demandée par Camille pour Marion ».
  await page.goto('/approbations');
  await expect(page.getByText('Demandée par Camille pour Marion').first()).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/approbations-pour-un-membre-${width}.png`, fullPage: true });

  // Fiche bloquée vue par un membre.
  api.state.viewer = viewerAs('member', 'Marion');
  await mockCatalogue(page, { tv: { ...fixtures.tv, blocked: { by: 'keyword', keyword: 'anime' } } });
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByText('Bloqué (mot-clé « anime »)')).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-bloquee-${width}.png`, fullPage: true });

  // Confirmation du blocage par un gestionnaire.
  api.state.viewer = viewerAs('manager', 'Camille');
  await page.goto(`/titre/movie/${fixtures.movie.tmdbId}`);
  await page.getByRole('button', { name: 'Bloquer ce titre' }).click();
  await expect(page.getByRole('dialog', { name: /^Bloquer/ })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/bloquer-un-titre-${width}.png` });

  // Réglages › Blocages, une recherche de mot-clé en cours.
  api.state.blocklist = {
    titles: [
      {
        mediaType: 'tv',
        tmdbId: 1399,
        title: 'Game of Thrones',
        blockedBy: 'Camille',
        createdAt: '2026-11-10T09:00:00.000Z',
      },
      {
        mediaType: 'movie',
        tmdbId: 1003,
        title: 'Furiosa',
        blockedBy: 'Quentin',
        createdAt: '2026-11-02T18:30:00.000Z',
      },
    ],
    keywords: [
      { id: 210024, name: 'anime' },
      { id: 9715, name: 'superhero' },
    ],
  };
  api.state.keywordResults = [
    { id: 12377, name: 'zombie' },
    { id: 186565, name: 'zombie apocalypse' },
  ];
  await page.goto('/reglages');
  await page.getByLabel('Ajouter un mot-clé TMDB').fill('zomb');
  await expect(page.getByRole('list', { name: 'Mots-clés trouvés' }).getByRole('listitem')).toHaveCount(2);
  await page.screenshot({ path: `${dir}/reglages-blocages-${width}.png`, fullPage: true });

  // Réglages › Règles du propriétaire : « Masquer dans Découvrir ».
  api.state.viewer = viewerAs('owner');
  api.state.discover = { hideAvailable: true, hideRequested: false };
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Règles/ }).click();
  await expect(page.getByRole('checkbox', { name: /Titres disponibles/ })).toBeChecked();
  await page.getByRole('group', { name: 'Masquer dans Découvrir' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/reglages-masquer-${width}.png` });
});
