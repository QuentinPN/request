import type { MediaDetails } from '../src/shared/media.ts';
import { mockCatalogue, settleImages, shogun4k } from './catalogue-mocks.ts';
import { mockRequests } from './requests-mocks.ts';
import { arrServer, expect, test, viewerAs } from './support/api.ts';

// Captures de docs/captures/7.2, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures des serveurs Radarr/Sonarr et des demandes 4K (7.2)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/7.2';
  const width = project.name === 'mobile' ? 390 : 1440;

  api.state.arrServers = [
    arrServer(1, 'radarr'),
    arrServer(4, 'radarr', { name: 'Radarr bis', url: 'http://192.0.2.22:7878', isDefault: false }),
    arrServer(3, 'radarr', {
      name: 'Radarr 4K',
      url: 'http://192.0.2.21:7878',
      is4k: true,
      qualityProfileId: 5,
      rootFolderPath: '/films-4k',
    }),
    arrServer(2, 'sonarr'),
  ];
  await page.route('**/api/arr-servers/test', (route) =>
    route.fulfill({
      json: {
        version: '5.14.0',
        qualityProfiles: [
          { id: 4, name: 'HD-1080p' },
          { id: 5, name: 'Ultra-HD' },
        ],
        rootFolders: [
          { id: 1, path: '/films', freeSpace: 412 * 1024 ** 3 },
          { id: 2, path: '/films-4k', freeSpace: 1.8 * 1024 ** 4 },
        ],
      },
    }),
  );
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Radarr\b/ }).click();
  await page.getByRole('button', { name: 'Modifier Radarr 4K' }).click();
  await expect(page.getByText('Connexion réussie · Radarr v5.14.0')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-serveurs-${width}.png`, fullPage: true });

  // Fiche : saison 1 déjà en 4K, saison 2 en cours ; la 4K reste demandable pour la saison 3.
  api.state.viewer = viewerAs('member');
  const partial: MediaDetails = {
    ...shogun4k,
    fourK: { status: 'partial' },
    seasons: shogun4k.seasons.map((s, i) => ({
      ...s,
      fourK: i === 0 ? { status: 'available' } : i === 1 ? { status: 'requested' } : {},
    })),
  };
  await mockCatalogue(page, { tv: partial });
  await mockRequests(page);
  await page.goto(`/titre/tv/${partial.tmdbId}`);
  await expect(page.getByRole('button', { name: 'Demander en 4K' })).toBeVisible();
  await settleImages(page);
  await page.screenshot({ path: `${dir}/fiche-4k-${width}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Demander en 4K' }).click();
  await expect(page.getByRole('dialog').getByText('Demander une série en 4K')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/demande-4k-${width}.png` });
});
