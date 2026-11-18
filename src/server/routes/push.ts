import type { FastifyInstance } from 'fastify';
import {
  PUSH_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_CHECK_PATH,
  PUSH_SUBSCRIPTION_PATH,
  PUSH_TEST_PATH,
  type PushPublicKey,
  type PushSubscriptionCheck,
  pushEndpointSchema,
  pushSubscriptionInputSchema,
} from '../../shared/notifications.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import { testMessage } from '../services/delivery.ts';
import type { PushService } from '../services/push.ts';
import { getAppTitle } from '../services/settings.ts';

const USER_AGENT_MAX = 300;

/** Push web du membre connecté : clé publique VAPID, abonnement de cet appareil, essai vers ses appareils. */
export function pushRoutes(app: FastifyInstance, push: PushService) {
  app.get(PUSH_PUBLIC_KEY_PATH, async (): Promise<PushPublicKey> => ({ publicKey: push.publicKey() }));

  app.put(PUSH_SUBSCRIPTION_PATH, async (req, reply) => {
    const subscription = parseRequest(pushSubscriptionInputSchema, req.body);
    const userAgent = req.headers['user-agent']?.slice(0, USER_AGENT_MAX) ?? null;
    push.subscribe(viewerOf(req).user.id, subscription, userAgent);
    return reply.code(204).send();
  });

  app.delete(PUSH_SUBSCRIPTION_PATH, async (req, reply) => {
    const { endpoint } = parseRequest(pushEndpointSchema, req.body);
    push.unsubscribe(viewerOf(req).user.id, endpoint);
    return reply.code(204).send();
  });

  // POST : l'endpoint (une longue adresse) voyage dans le corps, pas dans l'URL.
  app.post(PUSH_SUBSCRIPTION_CHECK_PATH, async (req): Promise<PushSubscriptionCheck> => {
    const { endpoint } = parseRequest(pushEndpointSchema, req.body);
    return { subscribed: push.owns(viewerOf(req).user.id, endpoint) };
  });

  app.post(PUSH_TEST_PATH, async (req) => {
    let reached: number;
    try {
      reached = await push.sendTo(
        viewerOf(req).user.id,
        testMessage(getAppTitle(app.data.db, app.data.cryptoKey), 'Les notifications arrivent sur cet appareil.'),
      );
    } catch {
      throw new HttpError(422, 'Le service de notifications du navigateur a refusé l’essai');
    }
    if (reached === 0) throw new HttpError(409, 'Aucun appareil abonné : activez d’abord les notifications ici');
    return { reached };
  });
}
