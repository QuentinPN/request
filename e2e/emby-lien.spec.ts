import { fixtures, mockCatalogue, posterOf } from './catalogue-mocks.ts';
import { embyTest, expect, expectNoAxeViolations, field, freshSetup, test } from './support/api.ts';

const trending = fixtures.discover.rows.find((row) => row.id === 'trending')?.items ?? [];
const [partial, available, downloading] = trending;

const LINK = { kind: 'emby' as const, publicUrl: 'https://emby.exemple.fr', serverId: 'srv-1' };
const watchHref = (itemId: string | undefined) =>
  `https://emby.exemple.fr/web/index.html#!/item?id=${itemId}&serverId=srv-1`;

test('la fiche propose « Regarder dans Emby » et le décompte d’épisodes de chaque saison', async ({ page, api }) => {
  api.state.embyLink = LINK;
  await mockCatalogue(page);
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();

  const watch = page.getByRole('link', { name: 'Regarder dans Emby' });
  await expect(watch).toHaveAttribute('href', watchHref(fixtures.tv.embyItemId));
  await expect(watch).toHaveAttribute('target', '_blank');
  await expect(watch).toHaveAttribute('rel', /noreferrer/);
  // Série partielle : « Demander » reste proposé à côté.
  await expect(page.getByRole('button', { name: 'Demander', exact: true })).toBeVisible();

  const season = (n: number) =>
    page
      .getByRole('region', { name: 'Saisons' })
      .getByRole('listitem')
      .nth(n - 1);
  await expect(season(1)).toContainText('10/10 épisodes');
  await expect(season(2)).toContainText('4/10 épisodes');
  await expect(season(2).locator('[data-status]')).toHaveText('En téléchargement');
  await expectNoAxeViolations(page);
});

test('sans adresse publique, aucun lien vers Emby, ni sur la fiche ni sur les affiches', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
  await expect(page.getByRole('heading', { level: 1, name: fixtures.tv.title })).toBeVisible();
  await expect(page.getByRole('link', { name: /Regarder/ })).toHaveCount(0);

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Tendances' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Regarder/ })).toHaveCount(0);
});

test('un titre sans id Emby n’a pas de lien, même avec une adresse publique', async ({ page, api }) => {
  api.state.embyLink = LINK;
  await mockCatalogue(page);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Tendances' })).toBeVisible();
  await expect(posterOf(page, downloading?.title).getByRole('link', { name: /Regarder/ })).toHaveCount(0);
});

test('les affiches : « Regarder » sur un titre disponible, une icône à côté de « Demander » sur un titre partiel', async ({
  page,
  api,
}) => {
  api.state.embyLink = LINK;
  await mockCatalogue(page);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Tendances' })).toBeVisible();

  const full = posterOf(page, available?.title).getByRole('link', { name: `Regarder ${available?.title} dans Emby` });
  await expect(full).toHaveAttribute('href', watchHref(available?.embyItemId));
  await expect(full).toHaveText('Regarder');
  await expect(posterOf(page, available?.title).getByRole('button', { name: /Demander/ })).toHaveCount(0);

  const partialPoster = posterOf(page, partial?.title);
  const icon = partialPoster.getByRole('link', { name: `Regarder ${partial?.title} dans Emby` });
  await expect(icon).toHaveAttribute('href', watchHref(partial?.embyItemId));
  await expect(partialPoster.getByRole('button', { name: `Demander ${partial?.title}` })).toBeAttached();

  // Le lien de l'affiche ne double pas le lien vers la fiche.
  await expect(partialPoster.getByRole('link', { name: new RegExp(`^${partial?.title}`) })).toHaveAttribute(
    'href',
    /^\/titre\/tv\//,
  );
  await expectNoAxeViolations(page);
});

test('le hero « À la une » propose aussi « Regarder dans Emby »', async ({ page, api }) => {
  api.state.embyLink = LINK;
  await mockCatalogue(page);
  await page.goto('/');
  const une = page.getByRole('region', { name: 'À la une' });
  await expect(une.getByRole('link', { name: 'Regarder dans Emby' })).toHaveAttribute(
    'href',
    watchHref(partial?.embyItemId),
  );
});

test('Réglages : l’adresse publique d’Emby est facultative, validée, et enregistrée avec le reste', async ({
  page,
  api,
}) => {
  api.state.settings.mediaServer = {
    kind: 'emby',
    url: 'http://192.0.2.20:8096',
    apiKey: { set: true },
    libraryIds: ['lib-films'],
    publicUrl: null,
  };
  await page.route('**/api/setup/mediaServer/test', (route) => route.fulfill({ json: embyTest }));
  let saved: unknown;
  await page.route('**/api/settings/mediaServer', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved = route.request().postDataJSON();
    return route.fulfill({
      json: {
        kind: 'emby',
        url: 'http://192.0.2.20:8096',
        apiKey: { set: true },
        libraryIds: ['lib-films'],
        publicUrl: 'https://emby.exemple.fr',
      },
    });
  });
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Serveur multimédia\b/ }).click();
  await expect(page.getByText('Connexion réussie')).toBeVisible();

  const publicUrl = field(page, 'Adresse publique d’Emby');
  const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
  await expect(publicUrl).toHaveValue('');
  await expect(save).toBeEnabled();

  await publicUrl.fill('emby.exemple.fr');
  await expect(publicUrl).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Adresse invalide : elle doit commencer par http:// ou https://')).toBeVisible();
  await expect(save).toBeDisabled();
  await expectNoAxeViolations(page);

  await publicUrl.fill('https://emby.exemple.fr');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Réglages enregistrés')).toBeVisible();
  expect(saved).toEqual({
    kind: 'emby',
    url: 'http://192.0.2.20:8096',
    apiKey: '',
    libraryIds: ['lib-films'],
    publicUrl: 'https://emby.exemple.fr',
  });
});

test('l’assistant montre le même champ dans la section Emby', async ({ page, api }) => {
  api.state.setup = structuredClone(freshSetup);
  api.state.viewer = null;
  await page.goto('/assistant');
  await page.getByRole('radio', { name: /^Emby/ }).check();
  await expect(field(page, 'Adresse publique d’Emby')).toBeVisible();
  await expect(page.getByText('Facultative.')).toBeVisible();
  await expectNoAxeViolations(page);
});
