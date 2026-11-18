import { z } from 'zod';
import type { MediaKey, Paged } from './media.ts';
import { settingsPathOf } from './settings-path.ts';
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

/**
 * Évènements que reçoivent les agents (Discord, ntfy, Telegram, webhook sortant) : ceux des demandes, plus
 * `auto_approved` (demande approuvée sans passer par un gestionnaire, pour prévenir ceux qui suivent les demandes). Ce
 * dernier n'est pas dans `notificationKinds` : il n'a pas de ligne dans la cloche (contrainte `CHECK` de la table).
 */
export const agentEventKinds = [...requestNotificationKinds, 'auto_approved'] as const;
export type AgentEventKind = (typeof agentEventKinds)[number];

/** Version des réglages d'agent écrite à chaque enregistrement : sa présence dit que `events` est un choix du propriétaire. */
export const AGENT_EVENTS_VERSION = 2;

/**
 * Anciennes configurations d'agent (sans `eventsVersion`) : `approved` sans `auto_approved` (ajouté après) reçoit aussi
 * les approbations automatiques, comme avant. Une configuration enregistrée depuis est prise telle quelle.
 */
export const withAutoApproved = <T extends { events: AgentEventKind[]; eventsVersion?: number }>(agent: T): T =>
  agent.eventsVersion === undefined && agent.events.includes('approved') && !agent.events.includes('auto_approved')
    ? { ...agent, events: [...agent.events, 'auto_approved'] }
    : agent;

// --- Entrées ---

export const NOTIFICATIONS_PAGE_SIZE = 20;
export const NOTIFICATIONS_READ_MAX = 100;

export const notificationListQuerySchema = z.object({ page: z.coerce.number().int().positive().default(1) });

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

/**
 * Services push des navigateurs, seuls destinataires des envois du serveur (pas d'adresse interne) : l'hôte d'un
 * endpoint doit être un sous-domaine de l'un d'eux. FCM (Chrome, Edge Chromium) : `fcm.googleapis.com` ; Firefox :
 * `updates.push.services.mozilla.com` ; WNS (Windows) : `*.notify.windows.com` ; Safari : `web.push.apple.com`.
 */
export const PUSH_SERVICE_DOMAINS = [
  'googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
] as const;

/** Endpoint HTTPS d'un service push connu (`PUSH_SERVICE_DOMAINS`), sans port explicite. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const { protocol, hostname, port } = new URL(endpoint);
  return protocol === 'https:' && port === '' && PUSH_SERVICE_DOMAINS.some((domain) => hostname.endsWith(`.${domain}`));
}

/** Longueurs maximales : un endpoint réel fait quelques centaines de caractères, les clés 87 (`p256dh`) et 22 (`auth`). */
export const PUSH_ENDPOINT_MAX = 2048;
export const PUSH_KEY_MAX = 128;
const pushKey = z.string().min(1).max(PUSH_KEY_MAX);

/** Abonnement push d'un appareil, tel que `PushSubscription.toJSON()` le donne dans le navigateur. */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(PUSH_ENDPOINT_MAX)
    .refine(isPushServiceEndpoint, 'Service de notifications push inconnu'),
  keys: z.object({ p256dh: pushKey, auth: pushKey }),
});
export type PushSubscriptionInput = z.input<typeof pushSubscriptionInputSchema>;
/** Un appareil, par son `endpoint` : désabonnement (les siens seulement), ou « est-il à moi ? ». */
export const pushEndpointSchema = pushSubscriptionInputSchema.pick({ endpoint: true });

/** Préférences du membre connecté (Compte), et l'avis des « Envoyer un essai ». */
export const NOTIFICATIONS_PATH = '/api/notifications';
export const NOTIFICATIONS_READ_PATH = `${NOTIFICATIONS_PATH}/read`;
export const NOTIFICATION_PREFERENCES_PATH = '/api/account/notifications';
/** Push : clé publique VAPID, abonnement de l'appareil (`PUT`, `DELETE`, vérification), essai vers ses appareils. */
export const PUSH_PUBLIC_KEY_PATH = '/api/push/public-key';
export const PUSH_SUBSCRIPTION_PATH = '/api/push/subscription';
export const PUSH_SUBSCRIPTION_CHECK_PATH = `${PUSH_SUBSCRIPTION_PATH}/check`;
export const PUSH_TEST_PATH = '/api/push/test';
/** Service worker de l'appli installable (`public/sw.js`), servi à la racine : sa portée est tout le site. */
export const SERVICE_WORKER_PATH = '/sw.js';
/** Réglage SMTP (propriétaire) et courriel d'essai vers son adresse. */
export const SMTP_SETTINGS_PATH = settingsPathOf('smtp');
export const SMTP_TEST_PATH = `${SMTP_SETTINGS_PATH}/test`;

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

/** Préférences, et ce qui les rend utiles : courriel réglé par le propriétaire, appareils abonnés au push. */
export interface NotificationPreferencesView extends NotificationPreferences {
  emailAvailable: boolean;
  pushDevices: number;
}

export interface PushPublicKey {
  publicKey: string;
}

/** Cet appareil (son `endpoint`) est-il abonné pour le membre connecté ? Faux s'il l'est pour un autre membre. */
export interface PushSubscriptionCheck {
  subscribed: boolean;
}

// --- Destination ---

/** Les gestionnaires vont à la file d'approbation, les autres à la fiche du titre. */
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

type NotificationTargetInput = Pick<NotificationView, 'kind' | 'issueId' | 'media'>;

/**
 * Destination d'une notification : la file d'approbation, le signalement, ou la fiche du titre ; `null` si la demande
 * ou le signalement n'existe plus.
 */
export function notificationTarget({
  kind,
  issueId,
  media,
}: NotificationTargetInput): 'queue' | { issueId: number } | MediaKey | null {
  if (toQueue[kind]) return 'queue';
  return issueId !== null ? { issueId } : media;
}

/** Même destination en chemin de l'appli (courriel, push) ; l'accueil si elle n'existe plus. */
export function notificationPath(notification: NotificationTargetInput): string {
  const target = notificationTarget(notification);
  if (target === 'queue') return '/approbations';
  if (target === null) return '/';
  return 'issueId' in target ? `/signalements?id=${target.issueId}` : `/titre/${target.type}/${target.tmdbId}`;
}
