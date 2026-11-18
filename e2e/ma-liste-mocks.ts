import type { Page, Route } from '@playwright/test';
import type { MaskedSetting } from '../src/shared/settings.ts';
import {
  TRAKT_SETTINGS_PATH,
  type WatchlistEntry,
  type WatchlistImportResult,
  type WatchlistPage,
} from '../src/shared/watchlist.ts';
import { mediaNamed } from './requests-mocks.ts';

// Faux `/api/watchlist*` : « Ma liste » en mémoire, typée par le contrat partagé, avec les écritures gardées pour les
// assertions (ajouts, retraits, aperçus et imports).

/** Titre des fixtures du catalogue, tel qu'il figure dans « Ma liste ». */
export const entryOf = (title: string, source: WatchlistEntry['source'] = 'manual'): WatchlistEntry => ({
  ...mediaNamed(title),
  source,
  addedAt: new Date(2026, 10, 12, 20, 2).toISOString(),
});

export interface ImportCall {
  source: string;
  dryRun: boolean;
  body: unknown;
}

const EMPTY_IMPORT: WatchlistImportResult = {
  dryRun: true,
  source: 'trakt',
  total: 0,
  truncated: false,
  imported: 0,
  alreadyInList: 0,
  skipped: [],
};

const WATCHLIST_ROUTE = /\/api\/watchlist(\/|\?|$)/;

export async function mockWatchlist(page: Page, initial: WatchlistEntry[] = []) {
  const state = {
    items: [...initial],
    adds: [] as unknown[],
    removes: [] as string[],
    imports: [] as ImportCall[],
    /** Réponse d'un import : `{ status, json }` à servir, relue à chaque appel (un test peut la changer). */
    importReply: (_call: ImportCall): { status: number; json: object } => ({ status: 200, json: EMPTY_IMPORT }),
    /** Titres ajoutés à la liste par un import réel (pas par un aperçu). */
    importAdds: [] as WatchlistEntry[],
  };
  const has = (type: string, id: number) => state.items.some((i) => i.type === type && i.tmdbId === id);

  await page.route(WATCHLIST_ROUTE, async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    const imported = pathname.match(/^\/api\/watchlist\/import\/(\w+)$/);
    if (imported && method === 'POST') {
      const call: ImportCall = {
        source: imported[1] as string,
        dryRun: new URL(request.url()).searchParams.get('dryRun') === '1',
        body: request.postDataJSON(),
      };
      state.imports.push(call);
      const reply = state.importReply(call);
      if (!call.dryRun && reply.status === 200) state.items.unshift(...state.importAdds);
      return route.fulfill({ status: reply.status, json: reply.json });
    }

    const item = pathname.match(/^\/api\/watchlist\/(movie|tv)\/(\d+)$/);
    if (item) {
      const [type, id] = [item[1] as string, Number(item[2])];
      if (method === 'DELETE') {
        state.removes.push(`${type}:${id}`);
        state.items = state.items.filter((i) => !(i.type === type && i.tmdbId === id));
        return route.fulfill({ json: { inList: false } });
      }
      return route.fulfill({ json: { inList: has(type, id) } });
    }

    if (method === 'POST') {
      const body = request.postDataJSON() as { type: string; tmdbId: number };
      state.adds.push(body);
      if (!has(body.type, body.tmdbId)) state.items.unshift({ ...entryOf('Le Robot sauvage') });
      return route.fulfill({ json: { inList: true } });
    }

    const body: WatchlistPage = { page: 1, totalPages: 1, total: state.items.length, results: state.items };
    return route.fulfill({ json: body });
  });
  return state;
}

/** Faux réglage Trakt : le Client ID n'y revient jamais, les écritures sont gardées. */
export async function mockTraktSetting(page: Page, set = false) {
  const state = {
    saved: { clientId: { set } } as MaskedSetting<'trakt'>,
    puts: [] as unknown[],
    putReply: { status: 200 } as { status: number; json?: object },
  };
  await page.route(`**${TRAKT_SETTINGS_PATH}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.saved });
    state.puts.push(route.request().postDataJSON());
    if (state.putReply.status !== 200)
      return route.fulfill({ status: state.putReply.status, json: state.putReply.json });
    state.saved = { clientId: { set: true } };
    return route.fulfill({ json: state.saved });
  });
  return state;
}
