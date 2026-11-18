import type { Locator, Page, Route } from '@playwright/test';
import { expect, expectNoAxeViolations, test, viewerAs } from './support/api.ts';
import { desktopNav, mobileTabs, moreEntries } from './support/nav.ts';

const pillLinks = ['Découvrir', 'Films', 'Séries', 'Demandes', 'Approbations'];

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
  for (const name of ['Plus', 'Rechercher', 'Notifications', 'Compte']) {
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

test('ordinateur : le menu « Plus » s’ouvre au clavier, les flèches parcourent ses entrées, Entrée navigue', async ({
  page,
}, { project }) => {
  test.skip(project.name !== 'ordinateur', 'pilule réservée à l’ordinateur');
  await page.goto('/');
  const plus = desktopNav(page).getByRole('button', { name: 'Plus', exact: true });
  await expect(plus).toHaveAttribute('aria-haspopup', 'menu');
  await expect(plus).toHaveAttribute('aria-expanded', 'false');

  await plus.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(plus).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveText(moreEntries);
  await expectNoAxeViolations(page);

  // Échap referme le menu et rend le focus au bouton.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(plus).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Ma liste' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Signalements' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/signalements$/);
  await expect(menu).toBeHidden();
  // La page ouverte depuis le menu marque « Plus » comme actif.
  await expect(plus).toHaveAttribute('aria-current', 'page');
});

test('ordinateur : la pilule tient de 1024 à 1440 px pour le propriétaire, sans chevaucher le nom ni la cloche', async ({
  page,
}, { project }) => {
  test.skip(project.name !== 'ordinateur', 'pilule réservée à l’ordinateur');
  // Pire cas : compteurs à deux chiffres sur « Approbations » et sur « Plus ».
  await page.route('**/api/requests/counts', (route) =>
    route.fulfill({ json: { pendingApprovals: 12, mineActive: 3 } }),
  );
  await page.route('**/api/issues/counts', (route) => route.fulfill({ json: { open: 15 } }));
  const nav = desktopNav(page);
  const box = async (locator: Locator) => {
    const found = await locator.boundingBox();
    if (!found) throw new Error('élément sans boîte');
    return found;
  };

  for (const width of [1024, 1180, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(nav.getByRole('link', { name: /^Approbations ?, 12 en attente$/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /^Plus ?, 15 signalements ouverts$/ })).toBeVisible();

    const header = page.locator('header').filter({ has: nav });
    const name = await box(header.getByRole('link').first());
    const pill = await box(nav);
    const actions = await box(page.getByRole('link', { name: 'Compte', exact: true }));
    const bell = await box(page.getByRole('button', { name: /^Notifications/ }));
    expect(name.x + name.width, `nom de l’appli à ${width} px`).toBeLessThanOrEqual(pill.x);
    expect(pill.x + pill.width, `pilule et cloche à ${width} px`).toBeLessThanOrEqual(bell.x);
    expect(bell.x + bell.width).toBeLessThanOrEqual(actions.x);
    expect(actions.x + actions.width, `compte à ${width} px`).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Chaque lien de la pilule tient sur une ligne.
    for (const link of await nav.getByRole('link').all()) expect((await box(link)).height).toBeLessThanOrEqual(38);
  }
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
  const tabs = mobileTabs(page);
  await expect(tabs).toBeVisible();
  await expect(desktopNav(page)).toBeHidden();
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

test('mobile : l’onglet Compte est actif sur les pages ouvertes depuis Compte', async ({ page }, { project }) => {
  test.skip(project.name !== 'mobile', 'barre d’onglets réservée au mobile');
  await page.goto('/signalements');
  await expect(mobileTabs(page).getByRole('link', { name: 'Compte' })).toHaveAttribute('aria-current', 'page');
});

const roles = [
  { role: 'owner', tabs: ['Découvrir', 'Rechercher', 'Demandes', 'Approuver', 'Compte'] },
  { role: 'manager', tabs: ['Découvrir', 'Rechercher', 'Demandes', 'Approuver', 'Compte'] },
  { role: 'member', tabs: ['Découvrir', 'Rechercher', 'Demandes', 'Compte'] },
] as const;

for (const { role, tabs: expected } of roles) {
  test(`mobile : ${role}, au plus cinq onglets sans chevauchement, le reste dans Compte`, async ({ page, api }, {
    project,
  }) => {
    test.skip(project.name !== 'mobile', 'barre d’onglets réservée au mobile');
    api.state.viewer = viewerAs(role);
    await page.route('**/api/issues/counts', (route) => route.fulfill({ json: { open: 4 } }));
    await page.goto('/');
    const tabs = mobileTabs(page);
    const items = tabs.locator(':scope > a, :scope > button');
    await expect(items).toHaveCount(expected.length);
    expect(await items.evaluateAll((els) => els.map((el) => el.textContent?.trim().replace(/\d.*$/, '')))).toEqual(
      expected,
    );

    const bar = await tabs.boundingBox();
    const boxes = await Promise.all((await items.all()).map((el) => el.boundingBox()));
    for (const [i, box] of boxes.entries()) {
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box && bar && box.x >= bar.x && box.x + box.width <= bar.x + bar.width).toBe(true);
      const next = boxes[i + 1];
      if (box && next) expect(box.x + box.width).toBeLessThanOrEqual(next.x);
    }
    // Chaque libellé tient en entier.
    for (const label of await tabs.locator('span.truncate').all()) {
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }

    // Les signalements ouverts se comptent sur Compte, qui ouvre les entrées secondaires.
    const gestionnaire = role !== 'member';
    const compte = tabs.getByRole('link', { name: /^Compte/ });
    if (gestionnaire) await expect(compte).toHaveAccessibleName('Compte , 4 signalements ouverts');
    else await expect(compte).toHaveAccessibleName('Compte');
    await compte.tap();
    for (const name of moreEntries) {
      const entry = page.getByRole('main').getByRole('link', { name: new RegExp(`^${name}`) });
      await expect(entry).toHaveCount(name === 'Statistiques' && role === 'member' ? 0 : 1);
    }
    await expectNoAxeViolations(page);
  });
}

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
