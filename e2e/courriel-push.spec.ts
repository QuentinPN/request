import type { Page } from '@playwright/test';
import { DEVICE_ENDPOINT, mockPreferences, mockSmtp, stubBrowserPush } from './canaux-mocks.ts';
import { expect, expectNoAxeViolations, field, test } from './support/api.ts';

// Compte (adresse, préférences, push de cet appareil) et Réglages › Notifications par courriel (SMTP).

const notifications = (page: Page) => page.getByRole('region', { name: 'Notifications' });

async function openCompte(page: Page) {
  await page.goto('/compte');
  await expect(notifications(page).getByLabel('Par courriel')).toBeVisible();
}

test('Compte : préférences par défaut, puis adresse validée et enregistrée', async ({ page }) => {
  const prefs = await mockPreferences(page);
  await stubBrowserPush(page, 'default');
  await openCompte(page);
  await expect(field(page, 'Adresse courriel')).toHaveValue('');
  await expect(page.getByText('L’envoi de courriels n’est pas encore configuré')).toBeVisible();
  await expect(page.getByLabel('Par courriel')).toBeChecked();
  await expect(page.getByLabel('Sur mes appareils (notifications push)')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toBeVisible();
  await expectNoAxeViolations(page);

  await field(page, 'Adresse courriel').fill('pas-une-adresse');
  await expect(page.getByText('Adresse invalide')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

  await field(page, 'Adresse courriel').fill('quentin@exemple.fr');
  await page.getByLabel('Sur mes appareils (notifications push)').uncheck();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Préférences enregistrées')).toBeVisible();
  expect(prefs.puts).toEqual([{ email: 'quentin@exemple.fr', emailNotifications: true, pushNotifications: false }]);
});

test('Compte : activer le push sur cet appareil, essai, puis désactivation', async ({ page }) => {
  const prefs = await mockPreferences(page, { emailAvailable: true });
  await stubBrowserPush(page, 'default');
  await openCompte(page);
  await page.getByRole('button', { name: 'Activer sur cet appareil' }).click();
  await expect(page.getByText('Les notifications push sont activées sur cet appareil.')).toBeVisible();
  await expect(page.getByText('1 appareil abonné en tout.')).toBeVisible();
  expect(prefs.subscriptions).toEqual([
    { method: 'PUT', body: { endpoint: DEVICE_ENDPOINT, keys: { p256dh: 'cle-appareil', auth: 'auth-appareil' } } },
  ]);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Envoyer un essai' }).click();
  await expect(page.getByText('Notification d’essai envoyée.')).toBeVisible();
  expect(prefs.pushTests).toBe(1);

  await page.getByRole('button', { name: 'Désactiver sur cet appareil' }).click();
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toBeVisible();
  expect(prefs.subscriptions.at(-1)).toEqual({ method: 'DELETE', body: { endpoint: DEVICE_ENDPOINT } });
});

test('Compte : appareil partagé, abonné pour un autre membre, il s’affiche désactivé et se réattribue', async ({
  page,
}) => {
  const prefs = await mockPreferences(page, { pushDevices: 0 }, { ownsDevice: false });
  await stubBrowserPush(page, 'granted', { subscribed: true });
  await openCompte(page);
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toBeVisible();
  await expect(page.getByText('Les notifications push sont activées sur cet appareil.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Activer sur cet appareil' }).click();
  await expect(page.getByText('Les notifications push sont activées sur cet appareil.')).toBeVisible();
  expect(prefs.subscriptions).toEqual([
    { method: 'PUT', body: { endpoint: DEVICE_ENDPOINT, keys: { p256dh: 'cle-appareil', auth: 'auth-appareil' } } },
  ]);
});

test('Compte : appareil déjà abonné pour ce membre, il s’affiche activé', async ({ page }) => {
  await mockPreferences(page, { pushDevices: 1 }, { ownsDevice: true });
  await stubBrowserPush(page, 'granted', { subscribed: true });
  await openCompte(page);
  await expect(page.getByText('Les notifications push sont activées sur cet appareil.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Désactiver sur cet appareil' })).toBeVisible();
});

test('déconnexion : l’appareil est désabonné (serveur et navigateur), sauf s’il est à un autre membre', async ({
  page,
}) => {
  const prefs = await mockPreferences(page, { pushDevices: 1 }, { ownsDevice: true });
  await stubBrowserPush(page, 'granted', { subscribed: true });
  await openCompte(page);
  await expect(page.getByRole('button', { name: 'Désactiver sur cet appareil' })).toBeVisible();
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion$/);
  expect(prefs.subscriptions).toEqual([{ method: 'DELETE', body: { endpoint: DEVICE_ENDPOINT } }]);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.ready).pushManager.getSubscription()),
  ).toBeNull();
});

test('déconnexion : un appareil abonné pour un autre membre reste abonné', async ({ page }) => {
  const prefs = await mockPreferences(page, { pushDevices: 0 }, { ownsDevice: false });
  await stubBrowserPush(page, 'granted', { subscribed: true });
  await openCompte(page);
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion$/);
  expect(prefs.subscriptions).toEqual([]);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.ready).pushManager.getSubscription()),
  ).not.toBeNull();
});

test('Compte : permission refusée, ou navigateur sans push, l’état est expliqué', async ({ page }) => {
  await mockPreferences(page);
  await stubBrowserPush(page, 'denied');
  await openCompte(page);
  await expect(page.getByText('Les notifications sont bloquées pour ce site')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('Compte : navigateur sans push', async ({ page }) => {
  await mockPreferences(page);
  await stubBrowserPush(page, 'unsupported');
  await openCompte(page);
  await expect(page.getByText('Ce navigateur ne permet pas les notifications push ici.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toHaveCount(0);
});

const smtpSection = (page: Page) => page.getByRole('button', { name: /^Notifications par courriel\b/ });

async function openSmtp(page: Page) {
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await smtpSection(page).click();
  await expect(smtpSection(page)).toHaveAttribute('aria-expanded', 'true');
}

test('Réglages : configurer le courriel, essai avec le formulaire, enregistrement sans renvoyer le secret', async ({
  page,
}) => {
  const smtp = await mockSmtp(page);
  await openSmtp(page);
  await expect(smtpSection(page)).toContainText('Désactivé');
  await expect(page.getByRole('button', { name: 'Envoyer un essai' })).toBeDisabled();
  await expectNoAxeViolations(page);

  await field(page, 'Serveur SMTP').fill('smtp.exemple.fr');
  await page.getByLabel('Sécurité').selectOption('tls');
  await expect(field(page, 'Port')).toHaveValue('465');
  await field(page, 'Identifiant').fill('appli');
  await field(page, 'Mot de passe').fill('secret');
  await field(page, 'Expéditeur').fill('Request <appli@exemple.fr>');
  const form = {
    enabled: true,
    host: 'smtp.exemple.fr',
    port: 465,
    security: 'tls',
    username: 'appli',
    password: 'secret',
    from: 'Request <appli@exemple.fr>',
  };

  await page.getByRole('button', { name: 'Envoyer un essai' }).click();
  await expect(page.getByText('Courriel d’essai envoyé')).toBeVisible();
  expect(smtp.tests).toEqual([form]);

  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Courriel enregistré')).toBeVisible();
  expect(smtp.puts).toEqual([form]);
  await expect(smtpSection(page)).toContainText('Actif');
  await expect(field(page, 'Mot de passe')).toHaveValue('');
  await expect(field(page, 'Mot de passe')).toHaveAttribute('placeholder', 'Mot de passe enregistré');

  await field(page, 'Expéditeur').fill('demandes@exemple.fr');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Courriel enregistré')).toBeVisible();
  const { password: _, ...withoutPassword } = form;
  expect(smtp.puts.at(-1)).toEqual({ ...withoutPassword, from: 'demandes@exemple.fr' });
});

test('Réglages : essai sans adresse du propriétaire, le lien mène à Compte', async ({ page }) => {
  const smtp = await mockSmtp(page, {
    enabled: true,
    host: 'smtp.exemple.fr',
    port: 587,
    security: 'starttls',
    username: null,
    password: { set: false },
    from: 'appli@exemple.fr',
  });
  smtp.testReply = { status: 409, json: { error: 'Renseignez d’abord votre adresse courriel dans Compte' } };
  await openSmtp(page);
  await expect(smtpSection(page)).toContainText('Actif');
  await page.getByRole('button', { name: 'Envoyer un essai' }).click();
  await expect(page.getByText('Renseignez d’abord votre adresse courriel dans Compte')).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('link', { name: 'Ouvrir Compte' }).click();
  await expect(page).toHaveURL(/\/compte$/);
});
