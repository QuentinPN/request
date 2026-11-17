import type { Page } from '@playwright/test';
import { fixtures, mockCatalogue, NO_RESULT_QUERY } from './catalogue-mocks.ts';
import { expect, expectNoAxeViolations, test } from './support/api.ts';

const tv = fixtures.tv;
const hero = fixtures.discover.rows[0]?.items[0];
const ficheHeading = (page: Page, title: string) => page.getByRole('heading', { level: 1, name: title });

test('Découvrir : hero du n° 1 des tendances, rangées et plateformes', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/');
  const une = page.getByRole('region', { name: 'À la une' });
  await expect(une.getByRole('heading', { name: hero?.title })).toBeVisible();
  await expect(une.getByRole('button', { name: 'Demander' })).toHaveAttribute('aria-disabled', 'true');
  await expect(une.getByRole('button', { name: 'Demander' })).toHaveAccessibleDescription('Disponible bientôt');
  for (const row of [...fixtures.discover.rows.map((r) => r.title), 'Par plateforme']) {
    await expect(page.getByRole('heading', { level: 2, name: row })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Netflix' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Netflix' })).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(fixtures.listing.results.length);
  await page.getByRole('button', { name: 'Charger plus' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(fixtures.listing.results.length * 2);
  await expect(page.getByRole('button', { name: 'Charger plus' })).toHaveCount(0);

  await page.goBack();
  await une.getByRole('link', { name: 'Plus d’infos' }).click();
  await expect(ficheHeading(page, tv.title)).toBeVisible();
});

test('une affiche se focalise au clavier, ← → parcourent la rangée, Entrée ouvre la fiche', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/');
  const rail = page.getByRole('region', { name: 'Tendances' });
  const [first, second] = fixtures.discover.rows[0]?.items ?? [];
  const firstLink = rail.getByRole('link', { name: new RegExp(`^${first?.title}`) });
  await firstLink.focus();
  await page.keyboard.press('ArrowRight');
  await expect(rail.getByRole('link', { name: new RegExp(`^${second?.title}`) })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(firstLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/titre/tv/${tv.tmdbId}`);
  await expect(ficheHeading(page, tv.title)).toBeVisible();
});

test('fiche d’une série : genres, saisons, distribution, où regarder et rangées', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto(`/titre/tv/${tv.tmdbId}`);
  await expect(ficheHeading(page, tv.title)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Genres' }).getByRole('listitem')).toHaveCount(tv.genres.length);
  await expect(page.getByText('2 saisons')).toBeVisible();
  const saisons = page.getByRole('region', { name: 'Saisons' });
  await expect(saisons.getByRole('listitem')).toHaveCount(tv.seasons.length);
  await expect(saisons.getByText('10 épisodes · 2024')).toBeVisible();
  const cast = page.getByRole('region', { name: 'Distribution' });
  for (const person of tv.cast.slice(0, 3)) await expect(cast.getByText(person.character)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Où regarder' }).getByText('Disney Plus')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Recommandations' })).toBeVisible();

  await page.getByRole('button', { name: 'Retour' }).click();
  await expect(page).toHaveURL('/');
});

test('la bande-annonce s’ouvre dans un dialogue et se ferme avec Échap', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto(`/titre/tv/${tv.tmdbId}`);
  const trigger = page.getByRole('button', { name: 'Bande-annonce' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: `Bande-annonce de ${tv.title}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('iframe')).toHaveAttribute(
    'src',
    new RegExp(`youtube-nocookie\\.com/embed/${tv.trailerKey}`),
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('un film sans bande-annonce n’affiche pas le bouton', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto(`/titre/movie/${fixtures.movie.tmdbId}`);
  await expect(ficheHeading(page, fixtures.movie.title)).toBeVisible();
  await expect(page.getByText('1 h 42')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bande-annonce' })).toHaveCount(0);
  await expect(page.getByText('Ce titre n’est proposé par aucune plateforme en France pour l’instant.')).toBeVisible();
});

test('Ctrl+K : la saisie affiche films, séries et personnes ; ↓ puis Entrée ouvre la fiche', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/demandes');
  await page.getByRole('heading', { level: 1 }).click();
  const dialog = page.getByRole('dialog', { name: 'Rechercher' });
  const openSearch = async () => {
    await page.keyboard.press('Control+K');
    await expect(dialog.getByRole('searchbox')).toBeFocused();
  };
  await openSearch();
  await page.keyboard.type('sho');
  const results = dialog.getByRole('listbox', { name: 'Films et séries' });
  await expect(results.getByRole('option')).toHaveCount(fixtures.search.results.length);
  await expect(dialog.getByText('Hiroyuki Sanada')).toBeVisible();
  await expect(results.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  const second = fixtures.search.results[1];
  await expect(results.getByRole('option', { name: new RegExp(second?.title ?? '') })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`/titre/tv/${tv.tmdbId}`);
  await expect(ficheHeading(page, tv.title)).toBeVisible();

  await openSearch();
  await page.keyboard.type(NO_RESULT_QUERY);
  await expect(dialog.getByText(`Rien pour « ${NO_RESULT_QUERY} »`)).toBeVisible();
});

test('Films : pilules de genre, grille et « Charger plus »', async ({ page }) => {
  await mockCatalogue(page);
  await page.goto('/films');
  const genres = page.getByRole('group', { name: 'Genres' });
  await expect(genres.getByRole('button', { name: 'Action' })).toHaveAttribute('aria-pressed', 'true');
  await genres.getByRole('button', { name: 'Drame' }).click();
  await expect(page).toHaveURL('/films?genre=18');
  await expect(genres.getByRole('button', { name: 'Drame' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('listitem')).toHaveCount(fixtures.listing.results.length);
});

test('TMDB non configuré (503) : état vide explicite, pas d’erreur', async ({ page }) => {
  await mockCatalogue(page, { failWith: () => 503 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Découvrir' })).toBeVisible();
  await expect(page.getByText('Le catalogue n’est pas encore configuré')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
});

test('erreur : « Réessayer » relance la requête et affiche les rangées', async ({ page }) => {
  let failing = true;
  await mockCatalogue(page, { failWith: () => (failing ? 500 : null) });
  await page.goto('/');
  const retry = page.getByRole('button', { name: 'Réessayer' });
  await expect(retry).toBeVisible();
  failing = false;
  await retry.click();
  await expect(page.getByRole('region', { name: 'À la une' })).toBeVisible();
  await expect(retry).toHaveCount(0);
});

for (const path of ['/', `/titre/tv/${tv.tmdbId}`]) {
  test(`axe : aucune violation sur ${path} avec le catalogue`, async ({ page }) => {
    await mockCatalogue(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });
}
