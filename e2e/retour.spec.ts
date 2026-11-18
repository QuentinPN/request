import type { Page } from '@playwright/test';
import { mockCatalogue } from './catalogue-mocks.ts';
import { mockIssues, quentin, sampleIssues } from './issues-mocks.ts';
import { mockWatchlist } from './ma-liste-mocks.ts';
import { mockStats } from './stats-mocks.ts';
import { expect, expectNoAxeViolations, test } from './support/api.ts';
import { desktopNav, mobileTabs } from './support/nav.ts';

// Le propriétaire (propriétaire par défaut du faux serveur) accède aux quatre pages ouvertes depuis Compte.
const subPages = [
  { link: 'Ma liste', path: '/ma-liste', heading: 'Ma liste' },
  { link: 'Signalements', path: '/signalements', heading: 'Signalements' },
  { link: 'Statistiques', path: '/statistiques', heading: 'Statistiques' },
  { link: 'Réglages', path: '/reglages', heading: 'Réglages' },
] as const;

test.beforeEach(async ({ page }) => {
  await mockCatalogue(page);
  await mockWatchlist(page, []);
  await mockStats(page);
  await mockIssues(page, quentin, sampleIssues());
});

const compteHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Compte' });

for (const { link, path, heading } of subPages) {
  test(`${heading} : « Retour » ramène à Compte depuis Compte, et mène à Compte sur une adresse ouverte directement`, async ({
    page,
  }) => {
    // Venue de Compte : l'historique de l'appli sert (le nom reste générique).
    await page.goto('/compte');
    await page.getByRole('link', { name: new RegExp(`^${link}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.getByRole('button', { name: 'Retour', exact: true }).click();
    await expect(page).toHaveURL(/\/compte$/);
    await expect(compteHeading(page)).toBeVisible();

    // Arrivée directe (lien, onglet neuf) : pas d'historique, « Retour » va à Compte au lieu de quitter l'appli.
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.getByRole('button', { name: 'Retour à Compte' }).click();
    await expect(page).toHaveURL(/\/compte$/);
    await expect(compteHeading(page)).toBeVisible();
  });
}

test('une page ouverte depuis Compte garde son parent actif : onglet Compte sur mobile, « Plus » et compte sur ordinateur', async ({
  page,
}, { project }) => {
  const mobile = project.name === 'mobile';
  const parent = (desktopPlace: 'plus' | 'compte') =>
    mobile
      ? mobileTabs(page).getByRole('link', { name: 'Compte' })
      : desktopPlace === 'plus'
        ? desktopNav(page).getByRole('button', { name: /^Plus/ })
        : page.getByRole('link', { name: 'Compte', exact: true });
  for (const { path, desktopPlace } of [
    { path: '/ma-liste', desktopPlace: 'plus' },
    { path: '/signalements', desktopPlace: 'plus' },
    { path: '/statistiques', desktopPlace: 'plus' },
    { path: '/reglages', desktopPlace: 'compte' },
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(parent(desktopPlace)).toHaveAttribute('aria-current', 'page');
  }
});

test('plateforme : « Retour » mène à Découvrir sur une adresse ouverte directement', async ({ page }) => {
  await page.goto('/plateforme/movie/8');
  await page.getByRole('button', { name: 'Retour à Découvrir' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('le bouton « Retour » se parcourt au clavier et ne casse pas l’accessibilité', async ({ page }) => {
  await page.goto('/compte');
  await page.getByRole('link', { name: /^Statistiques/ }).click();
  const back = page.getByRole('button', { name: 'Retour', exact: true });
  await back.focus();
  await expect(back).toBeFocused();
  await expectNoAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(compteHeading(page)).toBeVisible();
});
