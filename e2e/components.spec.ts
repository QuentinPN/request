import { expect, test } from '@playwright/test';

test('la feuille de demande s’ouvre au clavier et se ferme avec Échap', async ({ page }) => {
  await page.goto('/composants');
  const trigger = page.getByRole('button', { name: 'Ouvrir la feuille de demande' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Demander une série' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Saison 1/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('les affiches proposent « Demander » au focus', async ({ page }) => {
  await page.goto('/composants');
  const request = page.getByRole('button', { name: 'Demander Titre absent' });
  await request.focus();
  await expect(request).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demander Déjà demandé' })).toHaveCount(0);
});
