import { mockDiscord, WEBHOOK } from './discord-mocks.ts';
import { expect, field, test } from './support/api.ts';

// Captures de docs/captures/5.3, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures des notifications Discord dans Réglages (5.3)', async ({ page }, { project }) => {
  const dir = 'docs/captures/5.3';
  const width = project.name === 'mobile' ? 390 : 1440;
  await mockDiscord(page);
  await page.goto('/reglages');
  const section = page.getByRole('button', { name: /^Notifications Discord\b/ });
  await section.click();
  await expect(page.getByLabel('Envoyer les notifications sur Discord')).not.toBeChecked();
  await page.screenshot({ path: `${dir}/reglages-discord-${width}.png`, fullPage: true });

  await page.getByLabel('Envoyer les notifications sur Discord').check();
  await field(page, 'Adresse du webhook').fill(WEBHOOK);
  await page.getByLabel('Demande refusée').uncheck();
  await page.getByRole('button', { name: 'Tester' }).click();
  await expect(page.getByText('Message de test envoyé')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-discord-actif-${width}.png`, fullPage: true });
});
