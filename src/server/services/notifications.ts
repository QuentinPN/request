import { and, count, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { z } from 'zod';
import { keyOf } from '../../shared/media.ts';
import {
  isNotificationKind,
  type markNotificationsReadSchema,
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationKind,
  type NotificationPage,
  type NotificationsRead,
  type notificationListQuerySchema,
} from '../../shared/notifications.ts';
import { capabilitiesOf, roles } from '../../shared/roles.ts';
import type { RequestEventType } from '../../shared/status.ts';
import type { Data, Db } from '../db/index.ts';
import { media, notifications, requests, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { DAY_MS } from '../lib/time.ts';
import { loadSummaries } from './tmdb.ts';

type ListQuery = z.output<typeof notificationListQuerySchema>;
type ReadInput = z.output<typeof markNotificationsReadSchema>;

/** Les notifications lues plus anciennes que ce délai sont supprimées par le balayage complet. */
export const NOTIFICATION_RETENTION_MS = 90 * DAY_MS;

// --- Texte ---

/** Données lues à l'affichage : titre TMDB et nom du demandeur peuvent manquer (TMDB en panne, demande supprimée). */
export interface MessageContext {
  title: string | null;
  requesterName: string | null;
  /** Motif du refus, raison de l'échec. */
  detail: string | null;
}

/** Texte d'une notification, en français : rendu à la lecture (rien de figé en base). */
export function notificationMessage(
  kind: NotificationKind,
  { title, requesterName, detail }: MessageContext,
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
        title: 'Disponible dans Emby',
        body: `${quoted ?? 'Le titre que vous avez demandé'} est disponible dans Emby.`,
      };
    case 'failed':
      return {
        title: 'Échec de l’envoi',
        body: `L’envoi${ofTitle}${requesterName ? `, demandé par ${requesterName},` : ''} a échoué${detail ? ` : ${detail}` : '.'}`,
      };
  }
}

// --- Écriture (dans la transaction de l'évènement) ---

/** Qui reçoit chaque notification. */
const RECIPIENTS: Record<NotificationKind, 'requester' | 'managers'> = {
  requested: 'managers',
  failed: 'managers',
  approved: 'requester',
  declined: 'requester',
  available: 'requester',
};
const managerRoles = roles.filter((role) => capabilitiesOf(role).canManageRequests);

export interface RequestEventFact {
  requestId: number;
  type: RequestEventType;
  actorId: string | null;
  detail: string | null;
  at: Date;
}

/**
 * Notifications d'un évènement de demande, écrites dans sa transaction : liées à la transition (elle-même
 * idempotente), un webhook rejoué n'en crée pas de nouvelles. Le membre qui agit n'est jamais prévenu de sa propre
 * action (approbation automatique, refus par un gestionnaire de sa propre demande). Une nouvelle demande ne prévient
 * les gestionnaires que si elle attend une approbation : pas pour un rôle à approbation automatique, ni pour des
 * saisons ajoutées à une demande déjà en attente (évènement `requested` avec détail).
 */
export function notifyRequestEvent(tx: Pick<Db, 'select' | 'insert'>, event: RequestEventFact) {
  const { type: kind, requestId, actorId, detail, at } = event;
  if (!isNotificationKind(kind)) return;
  const request = tx
    .select({ userId: requests.userId, role: users.role })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.userId))
    .where(eq(requests.id, requestId))
    .get();
  if (!request) return;
  if (kind === 'requested' && (detail !== null || capabilitiesOf(request.role).autoApprove)) return;
  const to =
    RECIPIENTS[kind] === 'requester'
      ? [request.userId]
      : tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.role, managerRoles))
          .all()
          .map((u) => u.id);
  const recipients = to.filter((id) => id !== actorId);
  if (recipients.length === 0) return;
  tx.insert(notifications)
    .values(recipients.map((userId) => ({ userId, kind, requestId, detail, createdAt: at })))
    .run();
}

/** Supprime les notifications lues créées avant `before` (balayage complet quotidien). */
export function purgeReadNotifications(db: Db, before: Date): number {
  return db
    .delete(notifications)
    .where(and(isNotNull(notifications.readAt), lt(notifications.readAt, before)))
    .run().changes;
}

// --- Lecture ---

/** Notifications du membre connecté : liste paginée, non lues, marquage comme lues. Jamais celles d'un autre. */
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

  const listQuery = (userId: string, page: number) =>
    db
      .select({
        notification: notifications,
        type: media.type,
        tmdbId: media.tmdbId,
        requesterName: users.name,
      })
      .from(notifications)
      .leftJoin(requests, eq(requests.id, notifications.requestId))
      .leftJoin(media, eq(media.id, requests.mediaId))
      .leftJoin(users, eq(users.id, requests.userId))
      .where(mine(userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(NOTIFICATIONS_PAGE_SIZE)
      .offset((page - 1) * NOTIFICATIONS_PAGE_SIZE);

  const unread = (userId: string) => unreadQuery(userId).get()?.n ?? 0;

  async function list(userId: string, query: ListQuery): Promise<NotificationPage> {
    const total = db.select({ n: count() }).from(notifications).where(mine(userId)).get()?.n ?? 0;
    const rows = listQuery(userId, query.page).all();
    const keyed = rows.map((r) => ({
      ...r,
      key: r.type && r.tmdbId !== null ? { type: r.type, tmdbId: r.tmdbId } : null,
    }));
    const titles = await loadSummaries(
      deps.tmdb,
      keyed.flatMap((r) => (r.key ? [r.key] : [])),
    );
    return {
      page: query.page,
      totalPages: Math.ceil(total / NOTIFICATIONS_PAGE_SIZE),
      unread: unread(userId),
      results: keyed.map(({ notification: n, key, requesterName }) => ({
        id: n.id,
        kind: n.kind,
        ...notificationMessage(n.kind, {
          title: key ? (titles.get(keyOf(key))?.title ?? null) : null,
          requesterName,
          detail: n.detail,
        }),
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
        requestId: n.requestId,
        media: key,
      })),
    };
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

  return { list, markRead, unread, unreadQuery, listQuery };
}

export type NotificationService = ReturnType<typeof createNotifications>;
