import type { FastifyInstance } from 'fastify';
import {
  markNotificationsReadSchema,
  type NotificationPage,
  type NotificationsRead,
  notificationListQuerySchema,
} from '../../shared/notifications.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import { createNotifications } from '../services/notifications.ts';

/** Notifications du membre connecté (session et CSRF par le garde global de `/api`) : les siennes seulement. */
export function notificationsRoutes(app: FastifyInstance) {
  const service = createNotifications(app.data, { tmdb: app.tmdb });

  app.get(
    '/api/notifications',
    async (req): Promise<NotificationPage> =>
      service.list(viewerOf(req).user.id, parseRequest(notificationListQuerySchema, req.query)),
  );

  app.post(
    '/api/notifications/read',
    async (req): Promise<NotificationsRead> =>
      service.markRead(viewerOf(req).user.id, parseRequest(markNotificationsReadSchema, req.body)),
  );
}
