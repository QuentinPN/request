import { z } from 'zod';
import type { MediaKey, Paged } from './media.ts';
import type { RequestEventType } from './status.ts';

/**
 * Évènements d'une demande qui donnent une notification (nom identique à l'évènement de la frise) : `requested` et
 * `failed` vont aux gestionnaires, `approved`, `declined` et `available` au membre qui a demandé.
 */
export const requestNotificationKinds = [
  'requested',
  'approved',
  'declined',
  'available',
  'failed',
] as const satisfies readonly RequestEventType[];
export type RequestNotificationKind = (typeof requestNotificationKinds)[number];

export const isRequestNotificationKind = (type: string): type is RequestNotificationKind =>
  (requestNotificationKinds as readonly string[]).includes(type);

/** Signalements : nouveau (gestionnaires), commentaire (participants), résolu ou rouvert (auteur). */
export const issueNotificationKinds = ['issue_created', 'issue_commented', 'issue_resolved', 'issue_reopened'] as const;
export type IssueNotificationKind = (typeof issueNotificationKinds)[number];

/**
 * Toutes les notifications, seule liste (contrainte `CHECK` de `notifications.kind`) : celles des demandes,
 * `requested_on_behalf` (un gestionnaire a demandé un titre à la place du membre) et celles des signalements.
 */
export const notificationKinds = [
  ...requestNotificationKinds,
  'requested_on_behalf',
  ...issueNotificationKinds,
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

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

/**
 * Préférences d'un membre (colonnes de `users`) : rien ne part par courriel sans adresse (ni SMTP réglé), ni en push
 * sans appareil abonné.
 */
export const notificationPreferencesSchema = z.object({
  email: z.email('Adresse invalide').nullable(),
  emailNotifications: z.boolean(),
  pushNotifications: z.boolean(),
});
export type NotificationPreferences = z.output<typeof notificationPreferencesSchema>;

/** Abonnement push d'un appareil, tel que `PushSubscription.toJSON()` le donne dans le navigateur. */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionInput = z.input<typeof pushSubscriptionInputSchema>;

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
  /** Signalement concerné (notifications `issue_*`) ; `null` si le signalement n'existe plus. */
  issueId: number | null;
  /** Titre concerné (lien vers sa fiche) ; `null` si la demande ou le signalement n'existe plus. */
  media: MediaKey | null;
}

/** Une page de notifications du membre, et son nombre total de non lues (pastille de la cloche). */
export interface NotificationPage extends Paged<NotificationView> {
  unread: number;
}

export interface NotificationsRead {
  unread: number;
}
