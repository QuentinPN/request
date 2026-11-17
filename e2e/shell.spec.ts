import type { Page, Route } from '@playwright/test';
import { expect, expectNoAxeViolations, test } from './support/api.ts';

const pillLinks = ['Découvrir', 'Films', 'Séries', 'Demandes', 'Approbations', 'Statistiques'];

const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Rechercher' });

test('ordinateur : Tab atteint chaque lien de la pilule, Entrée navigue et marque la page active', async ({ page }, {
  project,
}) => {
  test.skip(project.name !== 'ordinateur', 'pilule réservée à l’ordinateur');
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Navigation principale' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navigation', exact: true })).toBeHidden();

  for (const name of pillLinks) {
    const link = nav.getByRole('link', { name, exact: true });
    for (let i = 0; i < 20 && !(await link.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(link).toBeFocused();
  }
  for (const name of ['Rechercher', 'Notifications', 'Compte']) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole(name === 'Compte' ? 'link' : 'button', { name, exact: true })).toBeFocused();
  }

  const demandes = nav.getByRole('link', { name: 'Demandes' });
  await demandes.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/demandes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes' })).toBeVisible();
  await expect(demandes).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Découvrir' })).not.toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Films' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Films' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Films' })).toHaveAttribute('aria-current', 'page');
});

test('ordinateur : la cloche ouvre un panneau sans notification', async ({ page }, { project }) => {
  test.skip(project.name !== 'ordinateur', 'cloche réservée à l’ordinateur');
  await page.goto('/');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByText('Aucune notification')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Aucune notification')).toBeHidden();
});

test('mobile : la barre d’onglets remplace la pilule et navigue', async ({ page }, { project }) => {
  test.skip(project.name !== 'mobile', 'barre d’onglets réservée au mobile');
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Navigation', exact: true });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeHidden();
  for (const name of ['Découvrir', 'Demandes', 'Approuver', 'Compte']) {
    const box = await tabs.getByRole('link', { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await tabs.getByRole('link', { name: 'Approuver' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'Approbations' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Approuver' })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('button', { name: 'Rechercher' }).tap();
  await expect(searchDialog(page)).toBeVisible();
});

test('Ctrl+K ouvre la recherche avec le focus dans le champ, Échap la ferme', async ({ page }) => {
  await page.goto('/demandes');
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Control+K');
  const dialog = searchDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('searchbox', { name: 'Rechercher un film, une série ou une personne' })).toBeFocused();
  await expect(dialog.getByText('Cherchez un film, une série ou une personne')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Échap rend le focus au bouton Rechercher, Ctrl+Maj+K n’ouvre rien', async ({ page }) => {
  await page.goto('/demandes');
  const trigger = page.getByRole('button', { name: 'Rechercher', exact: true });
  await trigger.click();
  await expect(searchDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchDialog(page)).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Control+Shift+K');
  await expect(searchDialog(page)).toBeHidden();
});

test('Réessayer recharge la page quand son chunk a échoué à se charger', async ({ page }) => {
  await page.goto('/demandes');
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes' })).toBeVisible();
  const blockChunk = (route: Route) => route.abort();
  await page.route(/\/assets\/films-[^/]*\.js/, blockChunk);
  await page.evaluate(() => {
    window.history.pushState({}, '', '/films');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const retry = page.getByRole('button', { name: 'Réessayer' });
  await expect(page.getByText('Cette page n’a pas pu se charger.')).toBeVisible();
  await expect(retry).toBeVisible();

  await page.unroute(/\/assets\/films-[^/]*\.js/, blockChunk);
  await retry.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Films' })).toBeVisible();
});

test('une adresse inconnue affiche la page introuvable', async ({ page }) => {
  await page.goto('/nulle-part');
  await expect(page.getByRole('heading', { level: 1, name: 'Page introuvable' })).toBeVisible();
  await page.getByRole('link', { name: 'Retour à Découvrir' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Découvrir' })).toBeVisible();
});

for (const path of ['/', '/demandes']) {
  test(`axe : aucune violation sur ${path}, recherche fermée puis ouverte`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Control+K');
    await expect(searchDialog(page)).toBeVisible();
    await expectNoAxeViolations(page);
  });
}
