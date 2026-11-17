import type { Page } from '@playwright/test';
import type { WatchlistImportResult } from '../src/shared/watchlist.ts';
import { mockCatalogue, settleImages } from './catalogue-mocks.ts';
import { mockDiscord } from './discord-mocks.ts';
import { entryOf, mockTraktSetting, mockWatchlist } from './ma-liste-mocks.ts';
import { expect, field, test, viewerAs } from './support/api.ts';

// Captures de docs/captures/7.5, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

const dir = 'docs/captures/7.5';
const titles = [
  'Conclave',
  'Le Robot sauvage',
  'Dune : Deuxième partie',
  'Severance',
  'Shōgun',
  'Oppenheimer',
  'Slow Horses',
  'Andor',
];

const preview: WatchlistImportResult = {
  dryRun: true,
  source: 'trakt',
  total: 14,
  truncated: false,
  imported: 11,
  alreadyInList: 2,
  skipped: [{ title: 'Un court métrage obscur', year: 2019, reason: 'no_tmdb_id' }],
};

async function shoot(page: Page, name: string, width: number) {
  await settleImages(page);
  await page.screenshot({ path: `${dir}/${name}-${width}.png`, fullPage: true });
}

test('captures de Ma liste et de ses imports (7.5)', async ({ page, api }, { project }) => {
  const width = project.name === 'mobile' ? 390 : 1440;
  api.state.viewer = viewerAs('owner');
  await mockCatalogue(page);
  const watchlist = await mockWatchlist(
    page,
    titles.map((title) => entryOf(title)),
  );
  const trakt = await mockTraktSetting(page);
  await mockDiscord(page);

  await page.goto('/ma-liste');
  await expect(page.getByRole('article')).toHaveCount(titles.length);
  await shoot(page, 'ma-liste', width);

  await page.getByRole('button', { name: 'Importer une liste' }).click();
  const dialog = page.getByRole('dialog', { name: 'Importer une liste' });
  await field(page, 'Nom d’utilisateur Trakt').fill('alice-trakt');
  watchlist.importReply = ({ dryRun }) => ({ status: 200, json: { ...preview, dryRun } });
  await dialog.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog.getByText('Aperçu : rien n’a encore été ajouté.')).toBeVisible();
  await page.screenshot({ path: `${dir}/import-trakt-${width}.png` });

  await dialog.getByRole('button', { name: 'Letterboxd' }).click();
  watchlist.importReply = ({ dryRun }) => ({
    status: 200,
    json: {
      dryRun,
      source: 'letterboxd',
      total: 6,
      truncated: false,
      imported: 3,
      alreadyInList: 1,
      skipped: [
        { title: 'Heat', year: 2010, reason: 'ambiguous' },
        { title: 'Un film introuvable', year: 2001, reason: 'not_found' },
      ],
    } satisfies WatchlistImportResult,
  });
  await field(page, 'Fichier watchlist.csv').setInputFiles({
    name: 'watchlist.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date,Name,Year,Letterboxd URI\n2024-01-01,Conclave,2024,https://boxd.it/a\n'),
  });
  await dialog.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(dialog.getByText('Correspondance incertaine')).toBeVisible();
  await page.screenshot({ path: `${dir}/import-letterboxd-${width}.png` });
  await page.keyboard.press('Escape');

  watchlist.items.length = 0;
  await page.goto('/ma-liste');
  await expect(page.getByText('Votre liste est vide')).toBeVisible();
  await shoot(page, 'ma-liste-vide', width);

  await page.goto('/titre/movie/1002');
  await expect(page.getByRole('button', { name: 'Ajouter à ma liste' })).toBeEnabled();
  await page.getByRole('button', { name: 'Ajouter à ma liste' }).click();
  await expect(page.getByRole('button', { name: 'Dans ma liste' })).toBeVisible();
  await shoot(page, 'fiche-dans-ma-liste', width);

  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Listes externes\b/ }).click();
  await field(page, 'Client ID de l’application Trakt').fill('mon-client-id');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Client ID Trakt enregistré')).toBeVisible();
  expect(trakt.puts).toHaveLength(1);
  await shoot(page, 'reglages-trakt', width);
});
