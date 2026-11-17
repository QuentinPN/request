import type { Page } from '@playwright/test';
import { STATS_PATH, type Stats } from '../src/shared/stats.ts';

/** Statistiques d'un salon qui vit depuis un an : un mois vide, des classements et des délais à lire. */
export const sampleStats: Stats = {
  requests: {
    total: 214,
    byStatus: { pending: 6, approved: 2, declined: 11, cancelled: 4, sent: 17, failed: 1, available: 173 },
    byMonth: [
      { month: '2025-12', count: 9 },
      { month: '2026-01', count: 14 },
      { month: '2026-02', count: 0 },
      { month: '2026-03', count: 21 },
      { month: '2026-04', count: 18 },
      { month: '2026-05', count: 26 },
      { month: '2026-06', count: 31 },
      { month: '2026-07', count: 12 },
      { month: '2026-08', count: 17 },
      { month: '2026-09', count: 23 },
      { month: '2026-10', count: 29 },
      { month: '2026-11', count: 14 },
    ],
    byType: { movie: 148, tv: 66 },
    byQuality: { standard: 196, fourK: 18 },
  },
  topMembers: [
    { id: 'u-1', name: 'Marion', avatarUrl: null, count: 52 },
    { id: 'u-2', name: 'Thomas', avatarUrl: null, count: 41 },
    { id: 'u-3', name: 'Quentin', avatarUrl: null, count: 33 },
    { id: 'u-4', name: 'Léa', avatarUrl: null, count: 19 },
    { id: 'u-5', name: 'Hugo', avatarUrl: null, count: 8 },
  ],
  topTitles: [
    { type: 'movie', tmdbId: 603, title: 'Matrix', year: 1999, posterPath: null, count: 5 },
    { type: 'tv', tmdbId: 1396, title: 'Breaking Bad', year: 2008, posterPath: null, count: 4 },
    { type: 'movie', tmdbId: 27205, title: 'Inception', year: 2010, posterPath: null, count: 4 },
    { type: 'movie', tmdbId: 98765, title: null, year: null, posterPath: null, count: 2 },
  ],
  delays: {
    approval: { samples: 138, medianSeconds: 5400, meanSeconds: 21600 },
    availability: { samples: 173, medianSeconds: 90000, meanSeconds: 259200 },
  },
  issues: { open: 3, resolved: 12 },
  members: 9,
  watchlist: { entries: 37, titles: 31 },
};

/** Faux `GET /api/stats` : répond `stats`, ou la réponse d'erreur `status` (403 pour un membre sans le droit). */
export async function mockStats(page: Page, stats: Stats = sampleStats, status = 200) {
  await page.route(`**${STATS_PATH}`, (route) =>
    route.fulfill(status === 200 ? { json: stats } : { status, json: { error: 'Accès refusé' } }),
  );
}
