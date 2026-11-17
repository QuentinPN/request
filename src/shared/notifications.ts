import { z } from 'zod';
import type { MediaKey, Paged } from './media.ts';
import type { RequestEventType } from './status.ts';

/**
 * Évènements d'une demande qui donnent une notification (nom identique à l'évènement de la frise) : `requested` et
 * `failed` vont aux gestionnaires, `approved`, `declined` et `available` au membre qui a demandé.
 */
export const notificationKinds = [
  'requested',
  'approved',
  'declined',
  'available',
  'failed',
] as const satisfies readonly RequestEventType[];
export type NotificationKind = (typeof notificationKinds)[number];

export const isNotificationKind = (type: string): type is NotificationKind =>
  (notificationKinds as readonly string[]).includes(type);

// --- Entrées ---

export const NOTIFICATIONS_PAGE_SIZE = 20;
export const NOTIFICATIONS_READ_MAX = 100;

export const notificationListQuerySchema = z.object({ page: z.coerce.number().int().positive().default(1) });
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;

/** Marquer comme lues : certaines (`ids`, les siennes seulement) ou toutes. */
export const markNotificationsReadSchema = z.union([
  z.strictObject({ ids: z.array(z.number().int().positive()).min(1).max(NOTIFICATIONS_READ_MAX) }),
  z.strictObject({ all: z.literal(true) }),
]);
export type MarkNotificationsReadInput = z.input<typeof markNotificationsReadSchema>;

// --- Réponses ---

export interface NotificationView {
  id: number;
  kind: NotificationKind;
  /** Titre court (« Demande approuvée ») et phrase, rendus par le serveur à la lecture. */
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  requestId: number | null;
  /** Titre concerné (lien vers sa fiche) ; `null` si la demande n'existe plus. */
  media: MediaKey | null;
}

/** Une page de notifications du membre, et son nombre total de non lues (pastille de la cloche). */
export interface NotificationPage extends Paged<NotificationView> {
  unread: number;
}

export interface NotificationsRead {
  unread: number;
}
