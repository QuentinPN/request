import { expect, test } from './support/api.ts';

// Captures de docs/captures/3.4, hors `npm run verify` : `npm run captures` pour les régénérer.
test.skip(process.env.npm_lifecycle_event !== 'captures', 'captures générées à la demande');

test('captures du logo dans l’en-tête et la connexion (3.4)', async ({ page, api }, { project }) => {
  const dir = 'docs/captures/3.4';
  const width = project.name === 'mobile' ? 390 : 1440;
  // Le thème clair ne s'active que par l'attribut data-theme (cf. tokens.css).
  for (const theme of ['dark', 'light'] as const) {
    await page.goto('/');
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.screenshot({ path: `${dir}/en-tete-${theme}-${width}.png` });
  }

  api.state.viewer = null;
  await page.goto('/connexion');
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await page.screenshot({ path: `${dir}/connexion-${width}.png` });
});
