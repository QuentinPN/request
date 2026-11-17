import type { Page, Route } from '@playwright/test';
import { SEERR_IMPORT_PATH, type SeerrImportInput, type SeerrImportResult } from '../src/shared/import.ts';

export const seerrInput: SeerrImportInput = { url: 'http://192.0.2.20:5055', apiKey: 'cle-seerr' };

export const seerrPreview: SeerrImportResult = {
  dryRun: true,
  total: 42,
  imported: 35,
  alreadyPresent: 3,
  unmatchedUsers: [
    { seerrId: 7, name: 'Mamie', requests: 2 },
    { seerrId: 9, name: 'invite@exemple.fr', requests: 1 },
  ],
  unmatchedMedia: 1,
  skipped4k: 0,
};

/** Faux `POST /api/import/seerr` : aperçu ou import selon `?dryRun=1` ; `calls` garde chaque appel reçu. */
export async function mockSeerrImport(page: Page, { error }: { error?: string } = {}) {
  const calls: Array<{ dryRun: boolean; body: SeerrImportInput }> = [];
  await page.route(`**${SEERR_IMPORT_PATH}**`, (route: Route) => {
    const dryRun = new URL(route.request().url()).searchParams.get('dryRun') === '1';
    calls.push({ dryRun, body: route.request().postDataJSON() as SeerrImportInput });
    if (error) return route.fulfill({ status: 502, json: { error } });
    return route.fulfill({ json: dryRun ? seerrPreview : { ...seerrPreview, dryRun: false } });
  });
  return calls;
}

export async function openSeerrSection(page: Page) {
  await page.goto('/reglages');
  await page.getByRole('button', { name: /^Importer depuis Seerr\b/ }).click();
}
