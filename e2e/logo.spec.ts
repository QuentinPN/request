import { expect, expectNoAxeViolations, test } from './support/api.ts';

test('l’en-tête montre le logo, nommé « Request », qui mène à Découvrir', async ({ page }) => {
  await page.goto('/demandes');
  const home = page.getByRole('link', { name: 'Request', exact: true });
  await expect(home).toBeVisible();
  await expect(home.getByRole('img', { name: 'Request' })).toBeVisible();
  await expectNoAxeViolations(page);
  await home.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Découvrir' })).toBeVisible();
});

test('la connexion montre le logo, sans violation axe', async ({ page, api }) => {
  api.state.viewer = null;
  await page.goto('/connexion');
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Request' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('favicon, icône Apple et manifeste sont déclarés et servis', async ({ page, request }) => {
  await page.goto('/');
  const files = {
    'link[rel="icon"][type="image/svg+xml"]': 'image/svg+xml',
    'link[rel="icon"][type="image/png"][sizes="32x32"]': 'image/png',
    'link[rel="apple-touch-icon"]': 'image/png',
    'link[rel="manifest"]': 'application/manifest+json',
  };
  for (const [selector, type] of Object.entries(files)) {
    const href = await page.locator(selector).getAttribute('href');
    expect(href, selector).toBeTruthy();
    const res = await request.get(href ?? '');
    expect(res.status(), href ?? '').toBe(200);
    expect(res.headers()['content-type'], href ?? '').toContain(type);
  }
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#07080a');
});
