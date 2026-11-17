import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { LinkProps } from '@tanstack/react-router';
import type {
  MarkNotificationsReadInput,
  NotificationKind,
  NotificationPage,
  NotificationsRead,
  NotificationView,
} from '../../shared/notifications.ts';
import { apiGet, apiSend } from './http.ts';

// Seules définitions de la requête des notifications (clé, adresse, rafraîchissement), lues par la cloche.

export const notificationKeys = { all: ['notifications'] as const };

/** Pas de websocket : relue au retour sur l'onglet et toutes les minutes. */
export const NOTIFICATIONS_REFRESH_MS = 60_000;

/** Première page (les 20 plus récentes) et nombre de non lues. */
export const notificationsQuery = () =>
  queryOptions({
    queryKey: notificationKeys.all,
    queryFn: ({ signal }) => apiGet<NotificationPage>('/api/notifications', undefined, signal),
    refetchOnWindowFocus: true,
    refetchInterval: NOTIFICATIONS_REFRESH_MS,
  });

/** Marque comme lues (certaines, ou toutes), puis relit la liste. */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadInput) =>
      apiSend<NotificationsRead>('POST', '/api/notifications/read', input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

/** Les gestionnaires vont à la file d'approbation, le demandeur à la fiche du titre. */
const toQueue: Record<NotificationKind, boolean> = {
  requested: true,
  failed: true,
  approved: false,
  declined: false,
  available: false,
  requested_on_behalf: false,
  issue_created: false,
  issue_commented: false,
  issue_resolved: false,
  issue_reopened: false,
};

/** Destination d'une notification : la file d'approbation, ou la fiche du titre ; `null` si la demande n'existe plus. */
export function notificationLink(notification: NotificationView): LinkProps | null {
  if (toQueue[notification.kind]) return { to: '/approbations' };
  const { media } = notification;
  return media ? { to: '/titre/$type/$id', params: { type: media.type, id: String(media.tmdbId) } } : null;
}

/** « 1 non lue », « 3 non lues ». */
export const unreadLabel = (unread: number) => `${unread} non lue${unread > 1 ? 's' : ''}`;

/** Nom accessible de la cloche : le nombre de non lues y est dit, la pastille est décorative. */
export const bellLabel = (base: string, unread: number) => (unread === 0 ? base : `${base}, ${unreadLabel(unread)}`);
