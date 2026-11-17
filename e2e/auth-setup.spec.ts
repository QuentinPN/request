import type { Page } from '@playwright/test';
import {
  type ApiMock,
  completeSetup,
  embyTest,
  expect,
  expectNoAxeViolations,
  field,
  freshSetup,
  sonarrTest,
  test,
  viewerAs,
} from './support/api.ts';

const section = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}\\b`) });
const status = (page: Page) => page.getByRole('status').filter({ hasText: /\S/ });

function freshInstall(api: ApiMock) {
  api.state.setup = structuredClone(freshSetup);
  api.state.viewer = null;
}

async function fillEmby(page: Page) {
  await field(page, 'Adresse').fill('http://192.0.2.20:8096');
  await field(page, 'Clé d’API').fill('cle-emby');
}

test('installation neuve : toute page mène à l’assistant, Emby seul accessible', async ({ page, api }) => {
  freshInstall(api);
  await page.goto('/demandes');
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Configuration' })).toBeVisible();
  await expect(section(page, 'Emby')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'TMDB')).toBeDisabled();
  await expect(section(page, 'Règles et quotas')).toBeDisabled();
});

test('Emby : un test réussi affiche les bibliothèques, Entrée lance le test', async ({ page, api }) => {
  freshInstall(api);
  let body: unknown;
  await page.route('**/api/setup/emby/test', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: embyTest });
  });
  await page.goto('/assistant');
  await fillEmby(page);
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('Connexion réussie · Salon · Emby v4.9.1 · 3 bibliothèques');
  expect(body).toEqual({ url: 'http://192.0.2.20:8096', apiKey: 'cle-emby' });
  await expect(page.getByRole('checkbox', { name: /^Films/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Séries/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Musique/ })).not.toBeChecked();
  await expect(section(page, 'Emby')).toContainText('En cours');
});

test('Emby : un test en échec affiche le message du serveur', async ({ page, api }) => {
  freshInstall(api);
  await page.route('**/api/setup/emby/test', (route) =>
    route.fulfill({ status: 422, json: { error: 'Emby injoignable à cette adresse' } }),
  );
  await page.goto('/assistant');
  await fillEmby(page);
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(status(page)).toHaveText('Emby injoignable à cette adresse');
  await expect(section(page, 'Emby')).toContainText('Erreur');
  await expect(page.getByRole('button', { name: 'Enregistrer et continuer' })).toBeDisabled();
});

test('Emby enregistré sans propriétaire : invitation à se connecter', async ({ page, api }) => {
  freshInstall(api);
  await page.route('**/api/setup/emby/test', (route) => route.fulfill({ json: embyTest }));
  let saved: unknown;
  await page.route('**/api/settings/emby', (route) => {
    saved = route.request().postDataJSON();
    api.state.setup.services.emby = true;
    return route.fulfill({
      json: { url: 'http://192.0.2.20:8096', apiKey: { set: true }, libraryIds: ['lib-films', 'lib-series'] },
    });
  });
  await page.goto('/assistant');
  await fillEmby(page);
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
  await expect(page.getByText('Connectez-vous avec un compte administrateur Emby pour continuer.')).toBeVisible();
  expect(saved).toEqual({
    url: 'http://192.0.2.20:8096',
    apiKey: 'cle-emby',
    libraryIds: ['lib-films', 'lib-series'],
    publicUrl: null,
  });
  await expect(section(page, 'Emby')).toContainText('Testé');
  await page.getByRole('link', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/connexion\?retour=%2Fassistant$/);
});

test('déconnecté : /demandes mène à la connexion, puis y revient', async ({ page, api }) => {
  api.state.viewer = null;
  await page.route('**/api/auth/login', (route) => {
    api.state.viewer = viewerAs('member', 'Marion');
    return route.fulfill({ json: { viewer: api.state.viewer } });
  });
  await page.goto('/demandes');
  await expect(page).toHaveURL(/\/connexion\?retour=%2Fdemandes$/);
  await expect(field(page, 'Identifiant')).toBeFocused();
  await field(page, 'Identifiant').fill('marion');
  await field(page, 'Mot de passe').fill('secret');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/demandes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Demandes' })).toBeVisible();
});

test('propriétaire sans Emby configuré : pas de boucle, message du serveur', async ({ page, api }) => {
  api.state.viewer = null;
  api.state.setup = { ...completeSetup, services: { ...completeSetup.services, emby: false }, complete: false };
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ status: 409, json: { error: 'Emby n’est pas encore configuré' } }),
  );
  await page.goto('/assistant');
  await expect(page).toHaveURL(/\/connexion\?retour=%2Fassistant$/);
  await expect(page.getByText('Emby n’est plus configuré : contactez le propriétaire de l’application.')).toBeVisible();
  await field(page, 'Identifiant').fill('marion');
  await field(page, 'Mot de passe').fill('secret');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toContainText('Emby n’est pas encore configuré');
  await expect(page).toHaveURL(/\/connexion\?retour=%2Fassistant$/);
});

test('connexion refusée : message du serveur, focus sur le mot de passe', async ({ page, api }) => {
  api.state.viewer = null;
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ status: 401, json: { error: 'Identifiant ou mot de passe Emby incorrect' } }),
  );
  await page.goto('/connexion');
  await field(page, 'Identifiant').fill('marion');
  await field(page, 'Mot de passe').fill('faux');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toHaveText('Identifiant ou mot de passe Emby incorrect');
  await expect(field(page, 'Mot de passe')).toBeFocused();
  await expect(page).toHaveURL(/\/connexion$/);

  await page.getByRole('button', { name: 'Afficher le mot de passe' }).click();
  await expect(field(page, 'Mot de passe')).toHaveAttribute('type', 'text');
});

test('un Membre ne voit pas Approbations', async ({ page, api }, { project }) => {
  api.state.viewer = viewerAs('member', 'Marion');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', {
    name: project.name === 'mobile' ? 'Navigation' : 'Navigation principale',
    exact: true,
  });
  await expect(nav.getByRole('link', { name: 'Demandes' })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Approbations|Approuver/ })).toHaveCount(0);
  await page.goto('/reglages');
  await expect(page).toHaveURL(/\/$/);
});

test('Compte : rôle affiché, déconnexion vers la connexion', async ({ page, api }) => {
  await page.goto('/compte');
  await expect(page.getByText('Propriétaire')).toBeVisible();
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion$/);
  expect(api.state.viewer).toBeNull();
});

test('une session perdue en cours de route ramène à la connexion', async ({ page, api }) => {
  await page.goto('/reglages');
  await section(page, 'TMDB').click();
  await field(page, 'Clé d’API ou jeton de lecture').fill('cle-tmdb');
  // La session expire côté serveur : le test suivant répond 401.
  api.state.viewer = null;
  await page.route('**/api/setup/tmdb/test', (route) =>
    route.fulfill({ status: 401, json: { error: 'Connexion requise' } }),
  );
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page).toHaveURL(/\/connexion\?retour=%2Freglages$/);
});

test('Réglages : une section enregistrée se teste à l’ouverture et remplit les listes', async ({ page, api }) => {
  api.state.settings.sonarr = {
    url: 'http://192.0.2.20:8989',
    apiKey: { set: true },
    qualityProfileId: 5,
    rootFolderPath: '/anime',
    seriesType: 'anime',
  };
  let tested: unknown;
  await page.route('**/api/setup/sonarr/test', (route) => {
    tested = route.request().postDataJSON();
    return route.fulfill({ json: sonarrTest });
  });
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await section(page, 'Sonarr').click();
  await expect(status(page)).toHaveText('Connexion réussie · Sonarr v4.0.11 · 3 profils, 2 dossiers');
  expect(tested).toEqual({ url: 'http://192.0.2.20:8989', apiKey: '' });
  await expect(field(page, 'Clé d’API')).toHaveAttribute('placeholder', 'Clé enregistrée');
  await expect(field(page, 'Profil de qualité')).toHaveValue('5');
  await expect(field(page, 'Dossier racine')).toHaveValue('/anime');
  await expect(page.getByRole('option', { name: '/series · 1,2 To libres' })).toBeAttached();
  await expect(field(page, 'Type de série')).toHaveValue('anime');
});

test('propriétaire et installation incomplète : retour à l’assistant, Terminer une fois fini', async ({
  page,
  api,
}) => {
  api.state.setup = { ...completeSetup, services: { ...completeSetup.services, rules: false }, complete: false };
  await page.route('**/api/settings/rules', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    api.state.setup = completeSetup;
    return route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(section(page, 'Règles et quotas')).toHaveAttribute('aria-expanded', 'true');
  await field(page, 'Nombre de films').fill('5');
  await page.getByRole('button', { name: 'Enregistrer et continuer' }).click();
  await page.getByRole('link', { name: 'Terminer' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('axe : aucune violation sur /connexion', async ({ page, api }) => {
  api.state.viewer = null;
  await page.goto('/connexion');
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('axe : aucune violation sur /assistant, section ouverte et testée', async ({ page, api }) => {
  freshInstall(api);
  await page.route('**/api/setup/emby/test', (route) => route.fulfill({ json: embyTest }));
  await page.goto('/assistant');
  await fillEmby(page);
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /^Films/ })).toBeVisible();
  await expectNoAxeViolations(page);
});
