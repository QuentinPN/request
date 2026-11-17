import type { Page, Route } from '@playwright/test';
import type { MarkNotificationsReadInput, NotificationPage, NotificationView } from '../src/shared/notifications.ts';

// Faux `/api/notifications*` : notifications en mémoire, typées par le contrat partagé.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const sampleNotifications = (): NotificationView[] => [
  {
    id: 3,
    kind: 'available',
    title: 'Disponible dans Emby',
    body: '« Dune : Deuxième partie » est disponible dans Emby.',
    read: false,
    createdAt: ago(12),
    requestId: 30,
    media: { type: 'movie', tmdbId: 693134 },
  },
  {
    id: 2,
    kind: 'requested',
    title: 'Nouvelle demande à approuver',
    body: 'Marie a demandé « The Bear ».',
    read: false,
    createdAt: ago(130),
    requestId: 20,
    media: { type: 'tv', tmdbId: 136315 },
  },
  {
    id: 1,
    kind: 'declined',
    title: 'Demande refusée',
    body: 'Votre demande de « Conclave » a été refusée. Motif : Déjà disponible en VO dans la bibliothèque.',
    read: true,
    createdAt: ago(3 * 24 * 60),
    requestId: 10,
    media: { type: 'movie', tmdbId: 974576 },
  },
];

/** Sert la liste et applique les marquages ; renvoie l'état pour les assertions. */
export async function mockNotifications(page: Page, results = sampleNotifications()) {
  const state = { results, reads: [] as MarkNotificationsReadInput[] };
  const unread = () => state.results.filter((n) => !n.read).length;
  await page.route('**/api/notifications**', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = request.postDataJSON() as MarkNotificationsReadInput;
      state.reads.push(input);
      state.results = state.results.map((n) => ('all' in input || input.ids.includes(n.id) ? { ...n, read: true } : n));
      return route.fulfill({ json: { unread: unread() } });
    }
    const body: NotificationPage = { page: 1, totalPages: 1, unread: unread(), results: state.results };
    return route.fulfill({ json: body });
  });
  return state;
}
