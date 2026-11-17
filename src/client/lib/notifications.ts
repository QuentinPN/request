import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { LinkProps } from '@tanstack/react-router';
import {
  type MarkNotificationsReadInput,
  type NotificationPage,
  type NotificationsRead,
  type NotificationView,
  notificationTarget,
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

/** Destination d'une notification (`notificationTarget`) : la file d'approbation, le signalement, la fiche, ou aucune. */
export function notificationLink(notification: NotificationView): LinkProps | null {
  const target = notificationTarget(notification);
  if (target === 'queue') return { to: '/approbations' };
  if (target === null) return null;
  if ('issueId' in target) return { to: '/signalements', search: { id: target.issueId } };
  return { to: '/titre/$type/$id', params: { type: target.type, id: String(target.tmdbId) } };
}

/** « 1 non lue », « 3 non lues ». */
export const unreadLabel = (unread: number) => `${unread} non lue${unread > 1 ? 's' : ''}`;

/** Nom accessible de la cloche : le nombre de non lues y est dit, la pastille est décorative. */
export const bellLabel = (base: string, unread: number) => (unread === 0 ? base : `${base}, ${unreadLabel(unread)}`);
