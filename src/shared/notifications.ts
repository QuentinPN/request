import { z } from 'zod';
import { type MediaKey, mediaKeySchema, pagedSchema } from './media.ts';
import { capabilitiesOf, type Permission, type PermissionHolder } from './roles.ts';
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
 * `auto_approved` (demande approuvée sans passer par un gestionnaire : prévient ceux qui suivent les demandes),
 * `requested_on_behalf` (un gestionnaire a demandé un titre à la place du membre) et celles des signalements.
 */
export const notificationKinds = [
  ...requestNotificationKinds,
  'auto_approved',
  'requested_on_behalf',
  ...issueNotificationKinds,
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/**
 * Évènements que reçoivent les agents (Discord, ntfy, Telegram, webhook sortant) : ceux des demandes, plus
 * `auto_approved` (qui est aussi une notification de l'appli, `notificationKinds`, depuis le lot 8.10).
 */
export const agentEventKinds = [...requestNotificationKinds, 'auto_approved'] as const;
export type AgentEventKind = (typeof agentEventKinds)[number];

/** Version des réglages d'agent écrite à chaque enregistrement : sa présence dit que `events` est un choix du propriétaire. */
export const AGENT_EVENTS_VERSION = 2;

/**
 * Anciennes configurations d'agent ou SMTP (sans `eventsVersion`) : `approved` sans `auto_approved` (ajouté après) reçoit aussi
 * les approbations automatiques, comme avant. Une configuration enregistrée depuis est prise telle quelle.
 */
export const withAutoApproved = <T extends { events: NotificationKind[]; eventsVersion?: number }>(agent: T): T =>
  agent.eventsVersion === undefined && agent.events.includes('approved') && !agent.events.includes('auto_approved')
    ? { ...agent, events: [...agent.events, 'auto_approved'] }
    : agent;

// --- Types choisis par membre (lot 8.10) ---

/** Rubriques de la liste des types (Compte › Notifications). */
export const notificationGroups = ['requests', 'issues', 'management'] as const;
export type NotificationGroup = (typeof notificationGroups)[number];
export const notificationGroupLabels: Record<NotificationGroup, string> = {
  requests: 'Mes demandes',
  issues: 'Mes signalements',
  management: 'Gestion',
};

interface NotificationTypeInfo {
  group: NotificationGroup;
  /** Droit qu'il faut pour le recevoir ; `null` : tout membre (le demandeur, l'auteur, un participant). */
  capability: Permission | null;
  /** Explication sous le libellé (celui-ci : `eventLabels`, côté client). */
  hint: string;
  /** Reçu tant que le membre n'a pas choisi. */
  defaultOn: boolean;
}

/**
 * Seule source de ce que chaque type est pour un membre : sa rubrique, le droit qui en fait un destinataire « à
 * traiter » (`notifyRequestEvent` : ceux qui ont ce droit), phrase d'explication de la liste du Compte, et son état
 * par défaut (les libellés sont ceux de `eventLabels`). `auto_approved` est désactivé d'office : un gestionnaire existant ne reçoit rien de nouveau,
 * par courriel ou en push, sans l'avoir activé.
 */
export const notificationTypes: Record<NotificationKind, NotificationTypeInfo> = {
  approved: {
    group: 'requests',
    capability: null,
    hint: 'Une de vos demandes a été approuvée.',
    defaultOn: true,
  },
  declined: {
    group: 'requests',
    capability: null,
    hint: 'Une de vos demandes a été refusée, avec le motif.',
    defaultOn: true,
  },
  available: {
    group: 'requests',
    capability: null,
    hint: 'Un titre que vous avez demandé est prêt à être regardé.',
    defaultOn: true,
  },
  requested_on_behalf: {
    group: 'requests',
    capability: null,
    hint: 'Un gestionnaire a demandé un titre à votre place.',
    defaultOn: true,
  },
  issue_commented: {
    group: 'issues',
    capability: null,
    hint: 'Un signalement auquel vous participez a été commenté.',
    defaultOn: true,
  },
  issue_resolved: {
    group: 'issues',
    capability: null,
    hint: 'Un signalement que vous avez ouvert a été résolu.',
    defaultOn: true,
  },
  issue_reopened: {
    group: 'issues',
    capability: null,
    hint: 'Un signalement que vous avez ouvert a été rouvert.',
    defaultOn: true,
  },
  requested: {
    group: 'management',
    capability: 'canManageRequests',
    hint: 'Un membre a fait une demande qui attend une approbation.',
    defaultOn: true,
  },
  failed: {
    group: 'management',
    capability: 'canManageRequests',
    hint: 'Une demande approuvée n’a pas pu partir : elle est à relancer.',
    defaultOn: true,
  },
  auto_approved: {
    group: 'management',
    capability: 'canManageRequests',
    hint: 'Une demande est partie sans validation, grâce aux droits de son auteur.',
    defaultOn: false,
  },
  issue_created: {
    group: 'management',
    capability: 'canManageIssues',
    hint: 'Un membre a signalé un problème sur un titre.',
    defaultOn: true,
  },
};

/** Types que ce membre peut recevoir, dans l'ordre de `notificationKinds` (ceux de gestion, s'il en a le droit). */
export function receivableKinds(holder: PermissionHolder): NotificationKind[] {
  const capabilities = capabilitiesOf(holder);
  return notificationKinds.filter((kind) => {
    const { capability } = notificationTypes[kind];
    return capability === null || capabilities[capability];
  });
}

/**
 * Choix d'un membre (colonne `users.notification_types`) : type → reçu ou non, **seulement l'écart aux valeurs par
 * défaut** (`chosenTypes`), `null` = tout par défaut. Un type inconnu est ignoré à la lecture.
 */
const notificationChoicesShape = Object.fromEntries(
  notificationKinds.map((kind) => [kind, z.boolean().optional()]),
) as Record<NotificationKind, z.ZodOptional<z.ZodBoolean>>;
export const notificationChoicesSchema = z.object(notificationChoicesShape);
export type NotificationChoices = z.output<typeof notificationChoicesSchema>;

/** Le membre reçoit-il ce type ? Son choix, sinon la valeur par défaut du type. */
export const notificationEnabled = (choices: NotificationChoices | null, kind: NotificationKind): boolean =>
  choices?.[kind] ?? notificationTypes[kind].defaultOn;

/** Écart aux valeurs par défaut, `null` si aucun : la seule forme enregistrée en base. */
export function chosenTypes(choices: NotificationChoices): NotificationChoices | null {
  const diff: NotificationChoices = {};
  for (const kind of notificationKinds) {
    const choice = choices[kind];
    if (choice !== undefined && choice !== notificationTypes[kind].defaultOn) diff[kind] = choice;
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

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
 * sans appareil abonné. `types` : ses choix par type, valables pour la cloche, le courriel et le push ; absent =
 * inchangé, un type qu'il ne peut pas recevoir (`receivableKinds`) est refusé (403).
 */
export const notificationPreferencesSchema = z.object({
  email: z.email('Adresse invalide').nullable(),
  emailNotifications: z.boolean(),
  pushNotifications: z.boolean(),
  types: z.strictObject(notificationChoicesShape).optional(),
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

export const notificationViewSchema = z.object({
  id: z.number().int(),
  kind: z.enum(notificationKinds),
  /** Titre court (« Demande approuvée ») et phrase, rendus par le serveur à la lecture. */
  title: z.string(),
  body: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
  requestId: z.number().int().nullable(),
  /** Signalement concerné (notifications `issue_*`) ; `null` si le signalement n'existe plus. */
  issueId: z.number().int().nullable(),
  /** Titre concerné (lien vers sa fiche) ; `null` si la demande ou le signalement n'existe plus. */
  media: mediaKeySchema.nullable(),
});
export type NotificationView = z.output<typeof notificationViewSchema>;

/** Une page de notifications du membre, et son nombre total de non lues (pastille de la cloche). */
export const notificationPageSchema = pagedSchema(notificationViewSchema).extend({ unread: z.number().int() });
export type NotificationPage = z.output<typeof notificationPageSchema>;

export const notificationsReadSchema = z.object({ unread: z.number().int() });
export type NotificationsRead = z.output<typeof notificationsReadSchema>;

/**
 * Préférences, et ce qui les rend utiles : courriel réglé par le propriétaire, appareils abonnés au push. `types` :
 * valeur effective de chaque type que le membre peut recevoir, et eux seuls.
 */
export const notificationPreferencesViewSchema = notificationPreferencesSchema.omit({ types: true }).extend({
  types: notificationChoicesSchema,
  emailAvailable: z.boolean(),
  pushDevices: z.number().int(),
});
export type NotificationPreferencesView = z.output<typeof notificationPreferencesViewSchema>;

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
  auto_approved: false,
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
