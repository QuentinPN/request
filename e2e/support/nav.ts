import type { Page } from '@playwright/test';
import { expect } from './api.ts';

/** Entrées du menu « Plus » de la pilule (ordinateur), ouvertes depuis Compte sur mobile. */
export const moreEntries = ['Ma liste', 'Signalements', 'Statistiques'];

export const desktopNav = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' });

export const mobileTabs = (page: Page) => page.getByRole('navigation', { name: 'Navigation', exact: true });

/** Ouvre le menu « Plus » de la pilule et rend le menu. */
export async function openMoreMenu(page: Page) {
  await desktopNav(page).getByRole('button', { name: /^Plus/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Ouvre une entrée secondaire de la navigation : menu « Plus » sur ordinateur, bouton de la page Compte sur mobile. */
export async function openMoreEntry(page: Page, mobile: boolean, name: string) {
  if (mobile) {
    await page.goto('/compte');
    await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
  } else {
    await page.goto('/');
    await (await openMoreMenu(page)).getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
  }
}
