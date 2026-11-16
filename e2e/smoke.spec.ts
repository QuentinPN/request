import { expect, test } from '@playwright/test';

test("l'application démarre et l'API répond", async ({ page, request }) => {
  expect((await request.get('/api/health')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
