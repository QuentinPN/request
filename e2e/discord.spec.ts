import type { Page } from '@playwright/test';
import { requestNotificationKinds } from '@shared/notifications.ts';
import { mockDiscord, WEBHOOK } from './discord-mocks.ts';
import { expect, expectNoAxeViolations, field, test } from './support/api.ts';

const section = (page: Page) => page.getByRole('button', { name: /^Notifications Discord\b/ });

async function openDiscord(page: Page) {
  await page.goto('/reglages');
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await section(page).click();
  await expect(section(page)).toHaveAttribute('aria-expanded', 'true');
}

test('Réglages : Discord est désactivé par défaut, avec tous les évènements cochés', async ({ page }) => {
  await mockDiscord(page);
  await openDiscord(page);
  await expect(section(page)).toContainText('Désactivé');
  await expect(page.getByLabel('Envoyer les notifications sur Discord')).not.toBeChecked();
  for (const label of ['Nouvelle demande à approuver', 'Demande approuvée', 'Demande refusée'])
    await expect(page.getByLabel(label)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Tester' })).toBeDisabled();
  await expectNoAxeViolations(page);
});

test('activer : adresse, évènements choisis, test, puis enregistrement (l’adresse ne revient pas)', async ({
  page,
}) => {
  const discord = await mockDiscord(page);
  await openDiscord(page);
  await page.getByLabel('Envoyer les notifications sur Discord').check();
  await field(page, 'Adresse du webhook').fill(WEBHOOK);
  await page.getByLabel('Demande refusée').uncheck();

  await page.getByRole('button', { name: 'Tester' }).click();
  await expect(page.getByText('Message de test envoyé')).toBeVisible();
  expect(discord.tests).toEqual([{ webhookUrl: WEBHOOK }]);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Notifications Discord enregistrées')).toBeVisible();
  expect(discord.puts).toEqual([
    { webhookUrl: WEBHOOK, enabled: true, events: requestNotificationKinds.filter((k) => k !== 'declined') },
  ]);
  await expect(section(page)).toContainText('Actif');
  await expect(field(page, 'Adresse du webhook')).toHaveValue('');
  await expect(field(page, 'Adresse du webhook')).toHaveAttribute('placeholder', 'Adresse enregistrée');
});

test('adresse déjà enregistrée : Tester la réutilise, Enregistrer ne la renvoie pas', async ({ page }) => {
  const discord = await mockDiscord(page, { webhookUrl: { set: true }, enabled: true });
  await openDiscord(page);
  await expect(section(page)).toContainText('Actif');
  await page.getByRole('button', { name: 'Tester' }).click();
  await expect(page.getByText('Message de test envoyé')).toBeVisible();
  expect(discord.tests).toEqual([{}]);

  await page.getByLabel('Envoyer les notifications sur Discord').uncheck();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(section(page)).toContainText('Désactivé');
  expect(discord.puts).toEqual([{ enabled: false, events: requestNotificationKinds }]);
});

test('une adresse qui n’est pas celle d’un webhook Discord est refusée avant l’envoi', async ({ page }) => {
  const discord = await mockDiscord(page);
  await openDiscord(page);
  await field(page, 'Adresse du webhook').fill('https://exemple.fr/api/webhooks/1/abc');
  await expect(page.getByText('Adresse attendue : https://discord.com/api/webhooks/…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tester' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

  await field(page, 'Adresse du webhook').fill('');
  await page.getByLabel('Envoyer les notifications sur Discord').check();
  await expect(page.getByText('Collez l’adresse du webhook pour activer les notifications.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  expect(discord.puts).toEqual([]);
});

test('Tester : le refus de Discord s’affiche', async ({ page }) => {
  const discord = await mockDiscord(page);
  discord.testReply = { status: 422, json: { error: 'Webhook introuvable : a-t-il été supprimé dans Discord ?' } };
  await openDiscord(page);
  await field(page, 'Adresse du webhook').fill(WEBHOOK);
  await page.getByRole('button', { name: 'Tester' }).click();
  await expect(page.getByText('Webhook introuvable : a-t-il été supprimé dans Discord ?')).toBeVisible();
  await expectNoAxeViolations(page);
});
