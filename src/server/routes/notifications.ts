import type { FastifyInstance } from 'fastify';
import {
  markNotificationsReadSchema,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_PATH,
  type NotificationPage,
  type NotificationPreferencesView,
  type NotificationsRead,
  notificationListQuerySchema,
  notificationPreferencesSchema,
} from '../../shared/notifications.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import type { EmailService } from '../services/email.ts';
import type { NotificationService } from '../services/notifications.ts';
import type { PushService } from '../services/push.ts';
import { setNotificationPreferences, type User } from '../services/users.ts';

/**
 * Notifications du membre connecté (session et CSRF par le garde global de `/api`) : les siennes seulement, et ses
 * préférences (adresse, courriel, push).
 */
export function notificationsRoutes(
  app: FastifyInstance,
  { service, email, push }: { service: NotificationService; email: EmailService; push: PushService },
) {
  app.get(
    NOTIFICATIONS_PATH,
    async (req): Promise<NotificationPage> =>
      service.list(viewerOf(req).user.id, parseRequest(notificationListQuerySchema, req.query)),
  );

  app.post(
    NOTIFICATIONS_READ_PATH,
    async (req): Promise<NotificationsRead> =>
      service.markRead(viewerOf(req).user.id, parseRequest(markNotificationsReadSchema, req.body)),
  );

  const preferencesOf = (user: User): NotificationPreferencesView => ({
    email: user.email,
    emailNotifications: user.emailNotifications,
    pushNotifications: user.pushNotifications,
    emailAvailable: email.active() !== null,
    pushDevices: push.deviceCount(user.id),
  });

  app.get(NOTIFICATION_PREFERENCES_PATH, async (req) => preferencesOf(viewerOf(req).user));

  app.put(NOTIFICATION_PREFERENCES_PATH, async (req) => {
    const preferences = parseRequest(notificationPreferencesSchema, req.body);
    return preferencesOf(setNotificationPreferences(app.data.db, viewerOf(req).user.id, preferences));
  });
}
