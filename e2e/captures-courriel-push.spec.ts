import { mockPreferences, mockSmtp, stubBrowserPush } from './canaux-mocks.ts';
import { mockDiscord } from './discord-mocks.ts';
import { expect, field, test } from './support/api.ts';

// Captures de docs/captures/7.6, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures du courriel et du push : Compte, Réglages (7.6)', async ({ page }, { project }) => {
  const dir = 'docs/captures/7.6';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockPreferences(page, { email: 'quentin@exemple.fr', emailAvailable: true, pushDevices: 1 });
  await mockSmtp(page);
  await mockDiscord(page);
  await stubBrowserPush(page, 'default');

  await page.goto('/compte');
  await expect(page.getByRole('button', { name: 'Activer sur cet appareil' })).toBeVisible();
  await page.screenshot({ path: `${dir}/compte-notifications-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Activer sur cet appareil' }).click();
  await expect(page.getByRole('button', { name: 'Envoyer un essai' })).toBeVisible();
  await page.screenshot({ path: `${dir}/compte-push-actif-${width}.png`, fullPage: true });

  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Notifications par courriel\b/ }).click();
  await field(page, 'Serveur SMTP').fill('smtp.exemple.fr');
  await field(page, 'Identifiant').fill('appli');
  await field(page, 'Mot de passe').fill('secret');
  await field(page, 'Expéditeur').fill('Request <demandes@exemple.fr>');
  await page.getByRole('button', { name: 'Envoyer un essai' }).click();
  await expect(page.getByText('Courriel d’essai envoyé')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-courriel-${width}.png`, fullPage: true });
});
