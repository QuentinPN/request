import type { Page } from '@playwright/test';
import type { MediaDetails } from '../src/shared/media.ts';
import type { NotificationView } from '../src/shared/notifications.ts';
import { fixtures, mockCatalogue } from './catalogue-mocks.ts';
import { type IssuesMock, mockIssues, quentin, sampleIssues } from './issues-mocks.ts';
import { mockNotifications } from './notifications-mocks.ts';
import { test as base, expect, expectNoAxeViolations, viewerAs } from './support/api.ts';

/** Gestionnaire (propriétaire) devant les trois signalements d'exemple, et un catalogue pour les affiches. */
const test = base.extend<{ issues: IssuesMock }>({
  issues: [
    async ({ page }, use) => {
      await mockCatalogue(page);
      await use(await mockIssues(page, quentin, sampleIssues()));
    },
    { auto: true },
  ],
});

const onlyDesktop = (project: { name: string }) => test.skip(project.name !== 'ordinateur', 'liste et panneau');
const onlyMobile = (project: { name: string }) => test.skip(project.name !== 'mobile', 'cartes et feuille');

const panel = (page: Page) => page.getByRole('complementary', { name: 'Détail du signalement' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Détail du signalement' });
const card = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(title) });

test('ordinateur : la liste des ouverts, avec le détail du premier et le compteur de la navigation', async ({ page }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/signalements');
  await expect(page.getByRole('heading', { level: 1, name: 'Signalements' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ouverts' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Ouverts/ })).toContainText('2');
  await expect(page.getByRole('button', { name: /^Résolus/ })).toContainText('1');
  await expect(card(page, 'Le Robot sauvage')).toContainText('Marion');
  await expect(panel(page).getByRole('heading', { name: 'Le Robot sauvage' })).toBeVisible();
  await expect(panel(page)).toContainText('Le son est très faible');
  // Gestionnaire : pastille des signalements ouverts à côté du lien.
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toContainText('2');
  await expectNoAxeViolations(page);
});

test('ordinateur : le fil d’une série, un commentaire s’ajoute et le champ se vide', async ({ page, issues }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/signalements');
  await card(page, 'Shōgun').click();
  await expect(panel(page)).toContainText('Sous-titres · Saison 1 · épisode 4');
  await expect(panel(page).getByRole('list', { name: 'Commentaires' }).getByRole('listitem')).toHaveCount(2);

  const field = panel(page).getByLabel('Commenter');
  await expect(panel(page).getByRole('button', { name: 'Commenter' })).toBeDisabled();
  await field.fill('C’est corrigé, relancez la lecture.');
  await panel(page).getByRole('button', { name: 'Commenter' }).click();
  await expect(panel(page).getByRole('list', { name: 'Commentaires' }).getByRole('listitem')).toHaveCount(3);
  await expect(field).toHaveValue('');
  expect(issues.comments).toEqual([{ id: 2, body: { message: 'C’est corrigé, relancez la lecture.' } }]);
  await expectNoAxeViolations(page);
});

test('ordinateur : résoudre sort le signalement des ouverts, un gestionnaire le rouvre', async ({ page, issues }, {
  project,
}) => {
  onlyDesktop(project);
  await page.goto('/signalements');
  await panel(page).getByRole('button', { name: 'Marquer comme résolu' }).click();
  await expect(panel(page).getByText('Résolu par Quentin')).toBeVisible();
  expect(issues.resolves).toEqual([1]);
  await expect(page.getByRole('list', { name: 'Ouverts' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Ouverts/ })).toContainText('1');

  await page.getByRole('button', { name: /^Résolus/ }).click();
  await expect(page.getByRole('list', { name: 'Résolus' }).getByRole('listitem')).toHaveCount(2);
  await card(page, 'Le Robot sauvage').first().click();
  await panel(page).getByRole('button', { name: 'Rouvrir' }).click();
  await expect(panel(page).getByRole('button', { name: 'Marquer comme résolu' })).toBeVisible();
  expect(issues.reopens).toHaveLength(1);
});

test('un membre ne voit que ses signalements, résout le sien mais ne le rouvre pas', async ({ page, api, issues }, {
  project,
}) => {
  onlyDesktop(project);
  const me = { id: 'id-member', name: 'Camille', avatarUrl: null };
  api.state.viewer = viewerAs('member', 'Camille');
  issues.issues = sampleIssues()
    .slice(0, 1)
    .map((i) => ({ ...i, author: me }));
  await page.goto('/signalements');
  await expect(page.getByRole('list', { name: 'Ouverts' }).getByRole('listitem')).toHaveCount(1);
  // Pas de compteur pour qui ne gère pas les signalements.
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).not.toContainText('1');

  await panel(page).getByRole('button', { name: 'Marquer comme résolu' }).click();
  await expect(panel(page).getByText('Résolu par Quentin')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Rouvrir' })).toBeHidden();
});

test('un signalement d’un autre n’est pas résoluble par un membre (pas de bouton)', async ({ page, api }, {
  project,
}) => {
  onlyDesktop(project);
  api.state.viewer = viewerAs('member', 'Camille');
  await page.goto('/signalements');
  await expect(panel(page).getByRole('button', { name: 'Commenter' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Marquer comme résolu' })).toBeHidden();
});

test('aucun signalement : message adapté', async ({ page, issues }) => {
  issues.issues = [];
  await page.goto('/signalements');
  await expect(page.getByText('Aucun signalement ouvert')).toBeVisible();
  await expect(page.getByText('Les problèmes signalés par les membres')).toBeVisible();
  await expectNoAxeViolations(page);
});

const commentedNotification: NotificationView = {
  id: 1,
  kind: 'issue_commented',
  title: 'Nouveau commentaire',
  body: 'Le signalement sur « Shōgun » a été commenté.',
  read: false,
  createdAt: new Date().toISOString(),
  requestId: null,
  issueId: 2,
  media: { type: 'tv', tmdbId: fixtures.tv.tmdbId },
};

test('une notification mène au signalement, ouvert d’emblée', async ({ page }, { project }) => {
  await mockNotifications(page, [commentedNotification]);
  await page.goto('/demandes');
  if (project.name === 'mobile') {
    await page
      .getByRole('navigation', { name: 'Navigation', exact: true })
      .getByRole('button', { name: /Alertes/ })
      .tap();
    await page
      .getByRole('dialog', { name: 'Notifications' })
      .getByRole('link', { name: /Nouveau commentaire/ })
      .tap();
    await expect(sheet(page).getByRole('heading', { name: 'Shōgun' })).toBeVisible();
  } else {
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.getByRole('link', { name: /Nouveau commentaire/ }).click();
    await expect(panel(page).getByRole('heading', { name: 'Shōgun' })).toBeVisible();
    await expect(card(page, 'Shōgun')).toHaveAttribute('aria-current', 'true');
  }
  await expect(page).toHaveURL(/\/signalements\?id=2$/);
});

test('mobile : une carte par signalement, la feuille du détail s’ouvre au toucher', async ({ page, issues }, {
  project,
}) => {
  onlyMobile(project);
  await page.goto('/signalements');
  await expect(page.getByRole('list', { name: 'Ouverts' }).getByRole('listitem')).toHaveCount(2);
  await expect(sheet(page)).toBeHidden();
  await expectNoAxeViolations(page);
  const tabs = page.getByRole('navigation', { name: 'Navigation', exact: true });
  await expect(tabs.getByRole('link', { name: /Problèmes/ })).toHaveAttribute('aria-current', 'page');
  // Sept onglets pour un gestionnaire : chaque libellé tient en entier.
  for (const link of await tabs.getByRole('link').all()) {
    const label = link.locator('span.truncate');
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }

  await card(page, 'Shōgun').tap();
  await expect(sheet(page).getByRole('heading', { name: 'Shōgun' })).toBeVisible();
  await expect(sheet(page).getByRole('list', { name: 'Commentaires' }).getByRole('listitem')).toHaveCount(2);
  await expectNoAxeViolations(page);
  await sheet(page).getByLabel('Commenter').fill('Merci du retour');
  await sheet(page).getByRole('button', { name: 'Commenter' }).tap();
  await expect(sheet(page).getByRole('list', { name: 'Commentaires' }).getByRole('listitem')).toHaveCount(3);
  expect(issues.comments).toHaveLength(1);

  await sheet(page).getByRole('button', { name: 'Fermer' }).tap();
  await expect(sheet(page)).toBeHidden();
  await expect(page).toHaveURL(/\/signalements$/);
});

// --- Feuille « Signaler un problème » de la fiche ---

const report = (page: Page) => page.getByRole('dialog', { name: 'Signaler un problème' });

test.describe('fiche titre', () => {
  test.beforeEach(({ api }) => {
    api.state.viewer = viewerAs('member', 'Camille');
  });

  test('une série partielle : type, saison, épisode et message partent au serveur', async ({ page, issues }) => {
    issues.issues = [];
    await page.goto(`/titre/tv/${fixtures.tv.tmdbId}`);
    await page.getByRole('button', { name: 'Signaler un problème' }).click();
    const dialog = report(page);
    await expect(dialog.getByLabel('Épisode (facultatif)')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Signaler', exact: true })).toBeDisabled();
    await dialog.getByLabel('Type de problème').selectOption('subtitles');
    await dialog.getByLabel('Saison (facultatif)').selectOption('1');
    await dialog.getByLabel('Épisode (facultatif)').fill('4');
    await dialog.getByLabel('Décrivez le problème').fill('  Les sous-titres sont décalés.  ');
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Signaler', exact: true }).click();

    await expect(dialog.getByText('Signalement envoyé.')).toBeVisible();
    expect(issues.posts).toEqual([
      {
        type: 'subtitles',
        mediaType: 'tv',
        tmdbId: fixtures.tv.tmdbId,
        seasonNumber: 1,
        episodeNumber: 4,
        message: '  Les sous-titres sont décalés.  ',
      },
    ]);
    await dialog.getByRole('link', { name: 'Mes signalements' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Signalements' })).toBeVisible();
  });

  test('un film disponible : pas de saison, le refus du serveur est affiché tel quel', async ({ page, issues }) => {
    const movie: MediaDetails = { ...fixtures.movie, status: 'available' };
    await page.route(`**/api/media/movie/${movie.tmdbId}`, (route) => route.fulfill({ json: movie }));
    issues.createError = {
      status: 409,
      error: 'Seul un titre disponible dans Emby peut faire l’objet d’un signalement',
    };
    await page.goto(`/titre/movie/${movie.tmdbId}`);
    await page.getByRole('button', { name: 'Signaler un problème' }).click();
    const dialog = report(page);
    await expect(dialog.getByLabel('Saison (facultatif)')).toHaveCount(0);
    await dialog.getByLabel('Décrivez le problème').fill('Image saccadée');
    await dialog.getByRole('button', { name: 'Signaler', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Seul un titre disponible dans Emby');
    expect(issues.posts).toEqual([
      {
        type: 'video',
        mediaType: 'movie',
        tmdbId: movie.tmdbId,
        seasonNumber: null,
        episodeNumber: null,
        message: 'Image saccadée',
      },
    ]);
  });

  test('un titre absent de la bibliothèque n’a pas le bouton', async ({ page }) => {
    await page.goto(`/titre/movie/${fixtures.movie.tmdbId}`);
    await expect(page.getByRole('heading', { level: 1, name: fixtures.movie.title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Signaler un problème' })).toHaveCount(0);
  });
});
