import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { keyOf } from '../../shared/media.ts';
import {
  type AgentEventKind,
  type AgentIssueEventKind,
  type IssueNotificationKind,
  isRequestNotificationKind,
  type markNotificationsReadSchema,
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationKind,
  type NotificationPage,
  type NotificationsRead,
  type NotificationView,
  notificationEnabled,
  type notificationListQuerySchema,
  notificationTypes,
} from '../../shared/notifications.ts';
import { autoApproves, capabilitiesOf } from '../../shared/roles.ts';
import type { RequestEventType } from '../../shared/status.ts';
import { changes, type Data, type Db } from '../db/index.ts';
import { issueComments, issues, media, notifications, requests, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { DAY_MS } from '../lib/time.ts';
import { mediaServerName } from './media-server.ts';
import { loadSummaries } from './tmdb.ts';

type ListQuery = z.output<typeof notificationListQuerySchema>;
type ReadInput = z.output<typeof markNotificationsReadSchema>;

/** Les notifications lues depuis plus longtemps que ce délai sont supprimées par le balayage complet. */
export const READ_NOTIFICATION_RETENTION_MS = 90 * DAY_MS;
/** Les notifications jamais lues, créées avant ce délai, le sont aussi (la table reste bornée). */
export const UNREAD_NOTIFICATION_RETENTION_MS = 365 * DAY_MS;

// --- Texte ---

/** Données lues à l'affichage : titre TMDB et nom du demandeur peuvent manquer (TMDB en panne, demande supprimée). */
export interface MessageContext {
  title: string | null;
  requesterName: string | null;
  /** Nom du serveur multimédia choisi (« Plex »), lu au moment de l'envoi ou de l'affichage. */
  serverName: string;
  /** Motif du refus, raison de l'échec. */
  detail: string | null;
}

/** Texte d'une notification, en français : rendu à la lecture (rien de figé en base). */
export function notificationMessage(
  kind: NotificationKind,
  { title, requesterName, detail, serverName }: MessageContext,
): { title: string; body: string } {
  const quoted = title ? `« ${title} »` : null;
  const ofTitle = quoted ? ` de ${quoted}` : '';
  switch (kind) {
    case 'requested':
      return {
        title: 'Nouvelle demande à approuver',
        body: `${requesterName ?? 'Un membre'} a demandé ${quoted ?? 'un titre'}.`,
      };
    case 'approved':
      return { title: 'Demande approuvée', body: `Votre demande${ofTitle} a été approuvée.` };
    case 'declined':
      return {
        title: 'Demande refusée',
        body: `Votre demande${ofTitle} a été refusée.${detail ? ` Motif : ${detail}` : ''}`,
      };
    case 'available':
      return {
        title: `Disponible dans ${serverName}`,
        body: `${quoted ?? 'Le titre que vous avez demandé'} est disponible dans ${serverName}.`,
      };
    case 'failed':
      return {
        title: 'Échec de l’envoi',
        body: `L’envoi${ofTitle}${requesterName ? `, demandé par ${requesterName},` : ''} a échoué${detail ? ` : ${detail}` : '.'}`,
      };
    case 'auto_approved':
      return {
        title: 'Demande approuvée automatiquement',
        body: `${requesterName ?? 'Un membre'} a demandé ${quoted ?? 'un titre'} : elle a été approuvée automatiquement.`,
      };
    case 'requested_on_behalf':
      return { title: 'Demande faite pour vous', body: `${quoted ?? 'Un titre'} a été demandé pour vous.` };
    case 'issue_created':
      return { title: 'Nouveau signalement', body: `Un problème a été signalé sur ${quoted ?? 'un titre'}.` };
    case 'issue_commented':
      return { title: 'Nouveau commentaire', body: `Le signalement sur ${quoted ?? 'un titre'} a été commenté.` };
    case 'issue_resolved':
      return { title: 'Signalement résolu', body: `Votre signalement sur ${quoted ?? 'un titre'} a été résolu.` };
    case 'issue_reopened':
      return { title: 'Signalement rouvert', body: `Votre signalement sur ${quoted ?? 'un titre'} a été rouvert.` };
  }
}

/**
 * Titre court d'un évènement d'agent : celui de la notification du membre, sauf les évènements propres aux agents
 * (`cancelled`, et `issue_opened` qui est `issue_created` côté appli).
 */
export function agentEventTitle(kind: AgentEventKind, serverName: string): string {
  if (kind === 'cancelled') return 'Demande annulée';
  const notificationKind = kind === 'issue_opened' ? 'issue_created' : kind;
  return notificationMessage(notificationKind, { title: null, requesterName: null, detail: null, serverName }).title;
}

// --- Écriture (dans la transaction de l'évènement) ---

/**
 * Destinataires « à traiter » d'un type : les membres qui ont son droit (`notificationTypes`, gérer les demandes ou les
 * signalements) ; `null` si le type n'en demande aucun (il va au demandeur, à l'auteur). Droits évalués membre par
 * membre (rôle et remplacements) : la table des membres reste petite.
 */
const holdersOf = (tx: Pick<Db, 'select'>, kind: NotificationKind): string[] | null => {
  const { capability } = notificationTypes[kind];
  if (!capability) return null;
  return tx
    .select({ id: users.id, role: users.role, permissions: users.permissions })
    .from(users)
    .all()
    .filter((u) => capabilitiesOf(u)[capability])
    .map((u) => u.id);
};

/** Une notification de l'appli, pour chacun de ses destinataires. */
export interface NotificationFact {
  kind: NotificationKind;
  recipients: readonly string[];
  /** Le membre qui agit n'est jamais prévenu de sa propre action. */
  actorId: string | null;
  requestId?: number | null;
  issueId?: number | null;
  /** Donnée brute de l'évènement (motif du refus, raison de l'échec). */
  detail: string | null;
  at: Date;
}

/** Notifications écrites ensemble (un évènement) : relues après la validation pour les autres canaux. */
export interface CreatedNotifications {
  kind: NotificationKind;
  at: Date;
  rows: ReadonlyArray<{ id: number; userId: string }>;
}

type CreatedListener = (created: CreatedNotifications) => void;
const createdListeners = new Set<CreatedListener>();

/**
 * S'abonne aux notifications écrites par `notify` (courriel, push). Appelé dans la transaction : l'écouteur ne fait que
 * planifier son travail (`AfterCommit`), qui relit les lignes après la validation. Renvoie le désabonnement.
 */
export function onNotificationsCreated(listener: CreatedListener): () => void {
  createdListeners.add(listener);
  return () => createdListeners.delete(listener);
}

/**
 * Seul point d'entrée des notifications : une ligne par destinataire, dans la transaction de l'évènement (annulée avec
 * elle), puis distribution aux autres canaux après validation selon les préférences de chacun (`services/delivery.ts`).
 * Tout type de `notificationKinds` passe par ici : rien à ajouter pour qu'il parte aussi par courriel et en push. Un
 * membre qui a désactivé ce type (`users.notification_types`, défaut du type sinon) n'a ni ligne, ni courriel, ni push.
 */
export function notify(tx: Pick<Db, 'select' | 'insert'>, fact: NotificationFact) {
  const { kind, actorId, detail, at } = fact;
  const candidates = [...new Set(fact.recipients)].filter((id) => id !== actorId);
  if (candidates.length === 0) return;
  const recipients = tx
    .select({ id: users.id, choices: users.notificationTypes })
    .from(users)
    .where(inArray(users.id, candidates))
    .all()
    .filter((u) => notificationEnabled(u.choices, kind))
    .map((u) => u.id);
  if (recipients.length === 0) return;
  const rows = tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        userId,
        kind,
        requestId: fact.requestId ?? null,
        issueId: fact.issueId ?? null,
        detail,
        createdAt: at,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId })
    .all();
  for (const listener of createdListeners) listener({ kind, at, rows });
}

export interface RequestEventFact {
  requestId: number;
  type: RequestEventType;
  actorId: string | null;
  detail: string | null;
  at: Date;
  /** Approbation automatique (droits du membre, aucun gestionnaire) : les agents la reçoivent comme `auto_approved`. */
  auto?: true;
}

/** Évènement de demande vu par les agents : `type` est celui de la frise, `kind` ce que l'agent en fait (`auto_approved`). */
export type AgentRequestEvent = RequestEventFact & { kind: Exclude<AgentEventKind, AgentIssueEventKind> };

/** Évènement de signalement vu par les agents : `actorId` est l'auteur (`issue_opened`) ou celui qui résout. */
export interface AgentIssueEvent {
  issueId: number;
  kind: AgentIssueEventKind;
  actorId: string | null;
  at: Date;
}

export type AgentEvent = AgentRequestEvent | AgentIssueEvent;

/** Un évènement de signalement, pas de demande. */
export const isAgentIssueEvent = (event: AgentEvent): event is AgentIssueEvent => 'issueId' in event;

type AgentEventListener = (event: AgentEvent) => void;
const agentEventListeners = new Set<AgentEventListener>();

/**
 * S'abonne aux évènements des agents (ceux de `notifyRequestEvent` et `notifyIssueEvent`, plus l'annulation d'une
 * demande, une fois par évènement et non par destinataire). L'écouteur est appelé dans la transaction de l'évènement :
 * il ne fait que planifier son travail, qui s'exécute après la validation. Renvoie le désabonnement.
 */
export function onAgentEvent(listener: AgentEventListener): () => void {
  agentEventListeners.add(listener);
  return () => agentEventListeners.delete(listener);
}

const emitAgentEvent = (event: AgentEvent) => {
  for (const listener of agentEventListeners) listener(event);
};

/**
 * Notifications d'un évènement de demande, écrites dans sa transaction : liées à la transition (elle-même
 * idempotente), un webhook rejoué n'en crée pas de nouvelles. Le membre qui agit n'est jamais prévenu de sa propre
 * action (approbation automatique, refus par un gestionnaire de sa propre demande). Une nouvelle demande ne prévient
 * les gestionnaires que si elle attend une approbation : pas pour une demande approuvée automatiquement
 * (`autoApproves`), ni pour des saisons ajoutées à une demande déjà en attente (évènement `requested` avec détail) ;
 * l'approbation automatique, elle, est l'évènement `auto_approved`. Les agents (Discord, ntfy, Telegram, webhook) sont
 * prévenus de ces mêmes évènements, sans l'exclusion de l'acteur : un salon n'est pas un destinataire.
 */
export function notifyRequestEvent(tx: Pick<Db, 'select' | 'insert'>, event: RequestEventFact) {
  const { type: kind, requestId, actorId, detail, at, auto } = event;
  // L'annulation prévient les agents seulement : le membre qui annule est le seul concerné, pas de notification de l'appli.
  if (kind === 'cancelled') return emitAgentEvent({ ...event, kind });
  if (!isRequestNotificationKind(kind)) return;
  const request = tx
    .select({
      userId: requests.userId,
      role: users.role,
      permissions: users.permissions,
      type: media.type,
      is4k: requests.is4k,
      createdBy: requests.createdBy,
    })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.userId))
    .innerJoin(media, eq(media.id, requests.mediaId))
    .where(eq(requests.id, requestId))
    .get();
  if (!request) return;
  // Même règle que l'approbation automatique de `requests.create` (`autoApproves`) : elle prévient à sa place.
  if (kind === 'requested' && (detail !== null || autoApproves(capabilitiesOf(request), request))) return;
  const agentEvent = { ...event, kind: auto ? ('auto_approved' as const) : kind };
  emitAgentEvent(agentEvent);
  notify(tx, { kind, recipients: holdersOf(tx, kind) ?? [request.userId], actorId, requestId, detail, at });
  // Approbation automatique : ceux qui suivent les demandes en sont prévenus (désactivé par défaut, `notificationTypes`),
  // sauf le gestionnaire qui a demandé à la place du membre : c'est lui qui agit.
  if (auto) {
    const recipients = (holdersOf(tx, 'auto_approved') ?? []).filter((id) => id !== request.createdBy);
    notify(tx, { kind: 'auto_approved', recipients, actorId, requestId, detail, at });
  }
}

/**
 * Demande faite par un gestionnaire à la place d'un membre : le membre est prévenu (`requested_on_behalf`), dans la
 * transaction de la demande, puis par courriel et push selon ses préférences (`notify`).
 */
export function notifyRequestedOnBehalf(
  tx: Pick<Db, 'select' | 'insert'>,
  { requestId, userId, actorId, at }: { requestId: number; userId: string; actorId: string; at: Date },
) {
  notify(tx, { kind: 'requested_on_behalf', recipients: [userId], actorId, requestId, detail: null, at });
}

export interface IssueEventFact {
  issueId: number;
  kind: IssueNotificationKind;
  actorId: string | null;
  at: Date;
}

/**
 * Notifications d'un évènement de signalement, écrites dans sa transaction : un nouveau signalement prévient les
 * gestionnaires des signalements ; un commentaire, l'auteur du signalement et ceux qui ont déjà commenté (celui de
 * l'auteur : les gestionnaires déjà intervenus, à défaut tous) ; résolu ou
 * rouvert, l'auteur. Le membre qui agit n'est jamais prévenu de sa propre action.
 */
export function notifyIssueEvent(tx: Pick<Db, 'select' | 'insert'>, { issueId, kind, actorId, at }: IssueEventFact) {
  const issue = tx.select({ userId: issues.userId }).from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) return;
  // Les agents : signalement créé ou résolu (pas rouvert ni commenté).
  if (kind === 'issue_created') emitAgentEvent({ issueId, kind: 'issue_opened', actorId, at });
  else if (kind === 'issue_resolved') emitAgentEvent({ issueId, kind, actorId, at });
  const managers = holdersOf(tx, 'issue_created') ?? [];
  let to: string[];
  if (kind === 'issue_created') to = managers;
  else if (kind === 'issue_commented') {
    // Seuls ceux qui peuvent encore voir le signalement : son auteur et les gestionnaires.
    const commenters = tx
      .select({ id: issueComments.userId })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), isNotNull(issueComments.userId)))
      .all()
      .flatMap((c) => (c.id && (c.id === issue.userId || managers.includes(c.id)) ? [c.id] : []));
    if (actorId !== issue.userId) to = [issue.userId, ...commenters];
    else {
      const managing = commenters.filter((id) => id !== issue.userId);
      to = managing.length > 0 ? managing : managers;
    }
  } else to = [issue.userId];
  notify(tx, { kind, recipients: to, actorId, issueId, detail: null, at });
}

/** Supprime les notifications lues et non lues trop anciennes (balayage complet quotidien). */
export function purgeOldNotifications(db: Db, now: Date): number {
  const readBefore = new Date(+now - READ_NOTIFICATION_RETENTION_MS);
  const unreadBefore = new Date(+now - UNREAD_NOTIFICATION_RETENTION_MS);
  return changes(
    db
      .delete(notifications)
      .where(
        or(
          and(isNotNull(notifications.readAt), lt(notifications.readAt, readBefore)),
          and(isNull(notifications.readAt), lt(notifications.createdAt, unreadBefore)),
        ),
      )
      .run(),
  );
}

// --- Lecture ---

/**
 * Notifications du membre connecté : liste paginée, non lues, marquage comme lues. Jamais celles d'un autre. Aussi le
 * rendu des notifications à distribuer (`committed`, courriel et push).
 */
export function createNotifications(data: Data, deps: { tmdb: () => TmdbClient; now?: () => number }) {
  const { db } = data;
  const now = deps.now ?? Date.now;
  const mine = (userId: string) => eq(notifications.userId, userId);

  /** Compté sur l'index partiel `notifications_unread_idx`. */
  const unreadQuery = (userId: string) =>
    db
      .select({ n: count() })
      .from(notifications)
      .where(and(mine(userId), isNull(notifications.readAt)));

  /** Notification et de quoi la rendre : titre concerné (par sa demande ou son signalement), nom du demandeur. */
  const viewSelect = () =>
    db
      .select({
        notification: notifications,
        type: media.type,
        tmdbId: media.tmdbId,
        requesterName: users.name,
      })
      .from(notifications)
      .leftJoin(requests, eq(requests.id, notifications.requestId))
      .leftJoin(issues, eq(issues.id, notifications.issueId))
      // Le titre vient de la demande ou du signalement de la notification (jamais des deux).
      .leftJoin(media, eq(media.id, sql`coalesce(${requests.mediaId}, ${issues.mediaId})`))
      .leftJoin(users, eq(users.id, requests.userId));
  type ViewRow = ReturnType<ReturnType<typeof viewSelect>['all']>[number];

  const listQuery = (userId: string, page: number) =>
    viewSelect()
      .where(mine(userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(NOTIFICATIONS_PAGE_SIZE)
      .offset((page - 1) * NOTIFICATIONS_PAGE_SIZE);

  const unread = (userId: string) => unreadQuery(userId).get()?.n ?? 0;

  /** Seul rendu des notifications (titres TMDB chargés en un lot) : pour la cloche, le courriel et le push. */
  async function render(rows: ViewRow[]): Promise<Array<{ userId: string; view: NotificationView }>> {
    const keyed = rows.map((r) => ({
      ...r,
      key: r.type && r.tmdbId !== null ? { type: r.type, tmdbId: r.tmdbId } : null,
    }));
    const titles = await loadSummaries(
      deps.tmdb,
      keyed.flatMap((r) => (r.key ? [r.key] : [])),
    );
    const serverName = mediaServerName(data);
    return keyed.map(({ notification: n, key, requesterName }) => ({
      userId: n.userId,
      view: {
        id: n.id,
        kind: n.kind,
        ...notificationMessage(n.kind, {
          title: key ? (titles.get(keyOf(key))?.title ?? null) : null,
          requesterName,
          detail: n.detail,
          serverName,
        }),
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
        requestId: n.requestId,
        issueId: n.issueId,
        media: key,
      },
    }));
  }

  async function list(userId: string, query: ListQuery): Promise<NotificationPage> {
    const total = db.select({ n: count() }).from(notifications).where(mine(userId)).get()?.n ?? 0;
    const rendered = await render(listQuery(userId, query.page).all());
    return {
      page: query.page,
      totalPages: Math.ceil(total / NOTIFICATIONS_PAGE_SIZE),
      unread: unread(userId),
      results: rendered.map((r) => r.view),
    };
  }

  /**
   * Notifications écrites par `notify`, rendues, si leur transaction a été validée (vide sinon) : relues par id avec
   * destinataire, type et date, car l'id d'une ligne annulée peut resservir. `only` : ces destinataires seulement.
   */
  async function committed(created: CreatedNotifications, only: ReadonlySet<string>) {
    const expected = new Map(created.rows.filter((r) => only.has(r.userId)).map((r) => [r.id, r.userId]));
    if (expected.size === 0) return [];
    const rows = viewSelect()
      .where(
        and(
          inArray(notifications.id, [...expected.keys()]),
          eq(notifications.kind, created.kind),
          eq(notifications.createdAt, created.at),
        ),
      )
      .all()
      .filter((r) => expected.get(r.notification.id) === r.notification.userId);
    return render(rows);
  }

  /** Marque comme lues les notifications choisies (celles d'un autre membre sont ignorées), ou toutes. */
  function markRead(userId: string, input: ReadInput): NotificationsRead {
    db.update(notifications)
      .set({ readAt: new Date(now()) })
      .where(
        and(
          mine(userId),
          isNull(notifications.readAt),
          'ids' in input ? inArray(notifications.id, input.ids) : undefined,
        ),
      )
      .run();
    return { unread: unread(userId) };
  }

  return { list, committed, markRead, unread, unreadQuery, listQuery };
}

export type NotificationService = ReturnType<typeof createNotifications>;
