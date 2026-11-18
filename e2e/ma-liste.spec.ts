import type { Page } from '@playwright/test';
import type { WatchlistImportResult } from '../src/shared/watchlist.ts';
import { mockCatalogue } from './catalogue-mocks.ts';
import { entryOf, mockTraktSetting, mockWatchlist } from './ma-liste-mocks.ts';
import { expect, expectNoAxeViolations, field, test, viewerAs } from './support/api.ts';
import { openMoreEntry } from './support/nav.ts';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Importer une liste' });

test.beforeEach(async ({ page, api }) => {
  api.state.viewer = viewerAs('member');
  await mockCatalogue(page);
});

test('Ma liste : affiches avec leur statut, lien vers la fiche, entrée dans la navigation', async ({ page }, {
  project,
}) => {
  await mockWatchlist(page, [entryOf('Conclave'), entryOf('Le Robot sauvage'), entryOf('Dune : Deuxième partie')]);
  // Ordinateur : menu « Plus » de la navigation. Mobile : la barre d'onglets n'a pas la page, on passe par Compte.
  await openMoreEntry(page, project.name === 'mobile', 'Ma liste');

  await expect(page).toHaveURL(/\/ma-liste$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ma liste' })).toBeVisible();
  await expect(page.getByText('3 titres')).toBeVisible();
  const posters = page.getByRole('article');
  await expect(posters).toHaveCount(3);
  await expect(posters.filter({ hasText: 'Conclave' })).toContainText('42 %');
  await expect(posters.filter({ hasText: 'Le Robot sauvage' })).toContainText('Disponible');
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: /^Conclave/ }).click();
  await expect(page).toHaveURL(/\/titre\/movie\/1003$/);
});

test('Ma liste : retirer un titre', async ({ page }) => {
  const watchlist = await mockWatchlist(page, [entryOf('Conclave'), entryOf('Le Robot sauvage')]);
  await page.goto('/ma-liste');
  await expect(page.getByRole('article')).toHaveCount(2);

  await page.getByRole('button', { name: 'Retirer Conclave de ma liste' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByText('1 titre', { exact: true })).toBeVisible();
  expect(watchlist.removes).toEqual(['movie:1003']);
});

test('Ma liste vide : explication et import', async ({ page }) => {
  await mockWatchlist(page);
  await page.goto('/ma-liste');
  await expect(page.getByText('Votre liste est vide')).toBeVisible();
  await expect(page.getByText('Aucun titre pour l’instant')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importer une liste' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('la fiche ajoute et retire le titre de la liste', async ({ page }) => {
  const watchlist = await mockWatchlist(page);
  await page.goto('/titre/movie/1002');
  const add = page.getByRole('button', { name: 'Ajouter à ma liste' });
  await expect(add).toBeEnabled();

  await add.click();
  await expect(page.getByRole('button', { name: 'Dans ma liste' })).toBeVisible();
  expect(watchlist.adds).toEqual([{ type: 'movie', tmdbId: 1002 }]);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Dans ma liste' }).click();
  await expect(page.getByRole('button', { name: 'Ajouter à ma liste' })).toBeVisible();
  expect(watchlist.removes).toEqual(['movie:1002']);
});

test('la fiche d’un titre déjà dans la liste le montre', async ({ page }) => {
  await mockWatchlist(page, [entryOf('Le Robot sauvage')]);
  await page.goto('/titre/movie/1002');
  await expect(page.getByRole('button', { name: 'Dans ma liste' })).toBeVisible();
});

const traktPreview: WatchlistImportResult = {
  dryRun: true,
  source: 'trakt',
  total: 5,
  truncated: false,
  imported: 3,
  alreadyInList: 1,
  skipped: [{ title: 'Film obscur', year: 2020, reason: 'no_tmdb_id' }],
};

test('import Trakt : aperçu puis import', async ({ page }) => {
  const watchlist = await mockWatchlist(page);
  watchlist.importAdds.push(entryOf('Conclave', 'trakt'), entryOf('Dune : Deuxième partie', 'trakt'));
  watchlist.importReply = ({ dryRun }) => ({ status: 200, json: { ...traktPreview, dryRun } });
  await page.goto('/ma-liste');
  await page.getByRole('button', { name: 'Importer une liste' }).click();
  await expect(dialog(page)).toBeVisible();

  await dialog(page).getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog(page).getByText('Nom d’utilisateur Trakt invalide')).toBeVisible();
  expect(watchlist.imports).toEqual([]);

  await field(page, 'Nom d’utilisateur Trakt').fill('alice-trakt');
  await dialog(page).getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog(page).getByText('Aperçu : rien n’a encore été ajouté.')).toBeVisible();
  await expect(dialog(page).getByText('Film obscur (2020)')).toBeVisible();
  await expect(dialog(page).getByText('Pas d’identifiant TMDB')).toBeVisible();
  await expect(dialog(page).getByText('À ajouter').locator('..')).toContainText('3');
  await expectNoAxeViolations(page);
  expect(watchlist.imports).toEqual([{ source: 'trakt', dryRun: true, body: { username: 'alice-trakt' } }]);

  await dialog(page).getByRole('button', { name: 'Importer 3 titres' }).click();
  await expect(dialog(page).getByText('Import terminé : 3 titres ajoutés à votre liste.')).toBeVisible();
  expect(watchlist.imports.at(-1)).toEqual({ source: 'trakt', dryRun: false, body: { username: 'alice-trakt' } });

  await dialog(page).getByRole('button', { name: 'Terminer' }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
});

test('import Trakt : profil privé, le message du serveur s’affiche', async ({ page }) => {
  const watchlist = await mockWatchlist(page);
  watchlist.importReply = () => ({
    status: 422,
    json: { error: 'Cette liste est introuvable ou privée. Vérifiez le nom d’utilisateur.' },
  });
  await page.goto('/ma-liste');
  await page.getByRole('button', { name: 'Importer une liste' }).click();
  await field(page, 'Nom d’utilisateur Trakt').fill('prive');
  await dialog(page).getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog(page).getByRole('status')).toContainText('introuvable ou privée');
  await expect(dialog(page).getByRole('button', { name: /^Importer \d/ })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('import Letterboxd : fichier watchlist.csv, aperçu puis import', async ({ page }) => {
  const watchlist = await mockWatchlist(page);
  const csv = 'Date,Name,Year,Letterboxd URI\n2024-01-01,Conclave,2024,https://boxd.it/a\n';
  watchlist.importAdds.push(entryOf('Conclave', 'letterboxd'));
  watchlist.importReply = ({ dryRun }) => ({
    status: 200,
    json: {
      dryRun,
      source: 'letterboxd',
      total: 3,
      truncated: false,
      imported: 1,
      alreadyInList: 0,
      skipped: [
        { title: 'Film inconnu', year: 2001, reason: 'not_found' },
        { title: 'Heat', year: 2010, reason: 'ambiguous' },
      ],
    } satisfies WatchlistImportResult,
  });
  await page.goto('/ma-liste');
  await page.getByRole('button', { name: 'Importer une liste' }).click();
  await dialog(page).getByRole('button', { name: 'Letterboxd' }).click();

  await dialog(page).getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog(page).getByText('Choisissez le fichier watchlist.csv')).toBeVisible();

  await field(page, 'Fichier watchlist.csv').setInputFiles({
    name: 'watchlist.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await dialog(page).getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog(page).getByText('Introuvable sur TMDB')).toBeVisible();
  await expect(dialog(page).getByText('Correspondance incertaine')).toBeVisible();
  await expectNoAxeViolations(page);
  expect(watchlist.imports).toEqual([{ source: 'letterboxd', dryRun: true, body: { csv } }]);

  await dialog(page).getByRole('button', { name: 'Importer 1 titre' }).click();
  await expect(dialog(page).getByText('Import terminé : 1 titre ajouté à votre liste.')).toBeVisible();
  expect(watchlist.imports.at(-1)).toMatchObject({ source: 'letterboxd', dryRun: false });
});

test('import Letterboxd : un fichier trop volumineux est refusé avant l’envoi', async ({ page }) => {
  const watchlist = await mockWatchlist(page);
  await page.goto('/ma-liste');
  await page.getByRole('button', { name: 'Importer une liste' }).click();
  await dialog(page).getByRole('button', { name: 'Letterboxd' }).click();
  await field(page, 'Fichier watchlist.csv').setInputFiles({
    name: 'watchlist.csv',
    mimeType: 'text/csv',
    buffer: Buffer.alloc(600 * 1024, 'a'),
  });
  await expect(dialog(page).getByText('Fichier trop volumineux : 512 Ko au plus.')).toBeVisible();
  expect(watchlist.imports).toEqual([]);
});

test.describe('Réglages (propriétaire)', () => {
  test.beforeEach(({ api }) => {
    api.state.viewer = viewerAs('owner');
  });

  const section = (page: Page) => page.getByRole('button', { name: /^Listes externes\b/ });

  test('Trakt est désactivé par défaut ; le Client ID est enregistré sans jamais revenir', async ({ page }) => {
    const trakt = await mockTraktSetting(page);
    await page.goto('/reglages');
    await section(page).click();
    await expect(section(page)).toContainText('Désactivé');
    await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await expectNoAxeViolations(page);

    await field(page, 'Client ID de l’application Trakt').fill('mon-client-id');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Client ID Trakt enregistré')).toBeVisible();
    expect(trakt.puts).toEqual([{ clientId: 'mon-client-id' }]);
    await expect(section(page)).toContainText('Actif');
    await expect(field(page, 'Client ID de l’application Trakt')).toHaveValue('');
    await expect(field(page, 'Client ID de l’application Trakt')).toHaveAttribute(
      'placeholder',
      'Client ID enregistré',
    );
  });

  test('un Client ID refusé par Trakt affiche le message du serveur', async ({ page }) => {
    const trakt = await mockTraktSetting(page);
    trakt.putReply = { status: 422, json: { error: 'Client ID Trakt refusé' } };
    await page.goto('/reglages');
    await section(page).click();
    await field(page, 'Client ID de l’application Trakt').fill('mauvais');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Client ID Trakt refusé')).toBeVisible();
    await expect(section(page)).toContainText('Erreur');
  });
});
