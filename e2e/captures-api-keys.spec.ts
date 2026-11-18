import { API_KEY_SECRET, expect, field, test } from './support/api.ts';

// Captures de docs/captures/7.8, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures de Réglages › API (7.8)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/7.8';
  const width = project.name === 'mobile' ? 390 : 1440;
  const now = Date.now();
  api.state.apiKeys = [
    {
      id: 2,
      name: 'Home Assistant',
      prefix: API_KEY_SECRET.slice(0, 8),
      createdByName: 'Quentin',
      createdAt: new Date(now - 3 * 86_400_000).toISOString(),
      lastUsedAt: new Date(now - 2 * 3_600_000).toISOString(),
      revokedAt: null,
    },
    {
      id: 1,
      name: 'Ancien script',
      prefix: 'ur_Qm7Bd',
      createdByName: 'Quentin',
      createdAt: new Date(now - 40 * 86_400_000).toISOString(),
      lastUsedAt: null,
      revokedAt: new Date(now - 10 * 86_400_000).toISOString(),
    },
  ];
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^API\b/ }).click();
  await expect(page.getByText('Ancien script')).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-api-${width}.png`, fullPage: true });

  await field(page, 'Nom de la clé').fill('Tautulli');
  await page.getByRole('button', { name: 'Créer la clé' }).click();
  await expect(page.getByRole('dialog', { name: 'Clé créée' })).toBeVisible();
  await page.screenshot({ path: `${dir}/reglages-api-cle-creee-${width}.png` });
});
