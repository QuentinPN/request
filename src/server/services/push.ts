import { and, eq, inArray } from 'drizzle-orm';
import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import { isPushServiceEndpoint, type PushSubscriptionInput } from '../../shared/notifications.ts';
import type { Setting } from '../../shared/settings.ts';
import type { Data } from '../db/index.ts';
import { pushSubscriptions } from '../db/schema.ts';
import type { OutgoingMessage } from './delivery.ts';
import { getSetting, setSetting } from './settings.ts';

/** Envoi vers un service push ; remplacé dans les tests (`web-push` simulé). */
export type PushSender = typeof sendNotification;

/** Une notification non remise dans la journée ne sert plus à rien. */
const PUSH_TTL_S = 24 * 3600;
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Contact VAPID exigé par les services push : l'adresse publique de l'appli en HTTPS (le push l'exige de toute façon),
 * sinon une adresse factice, acceptée par Chrome et Firefox mais pas forcément par Apple.
 */
export const vapidSubject = (publicUrl: string | null) =>
  publicUrl?.startsWith('https://') ? publicUrl : 'mailto:notifications@request.invalid';

/** Le service push ne connaît plus l'abonnement (désinstallé, expiré, retiré par le navigateur) : il est supprimé. */
const isGone = (error: unknown) =>
  error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410);

/**
 * Notifications push web : abonnements par appareil (`push_subscriptions`) et envoi signé VAPID. Les clés sont créées
 * au premier besoin et gardées dans le réglage `vapid` (privée chiffrée). `subject` : contact exigé par VAPID
 * (`https://…` ou `mailto:…`).
 */
export function createPush(data: Data, deps: { send: PushSender; subject: string }) {
  const { db, cryptoKey } = data;

  /** Clés VAPID, générées au premier appel (synchrone de bout en bout : deux appels ne peuvent pas en créer deux). */
  function keys(): Setting<'vapid'> {
    return getSetting(db, cryptoKey, 'vapid') ?? setSetting(db, cryptoKey, 'vapid', generateVAPIDKeys());
  }

  const devices = (userId: string) => db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

  const purge = (ids: number[]) => {
    if (ids.length > 0) db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, ids)).run();
  };

  /**
   * Envoie à chaque appareil du membre ; un appareil disparu (404, 410) est désabonné, les autres reçoivent quand même.
   * Un abonnement hors des services push connus (enregistré avant la règle) n'est jamais contacté : il est supprimé.
   * Renvoie le nombre d'appareils atteints ; lève le premier autre échec, après avoir tout tenté.
   */
  async function sendTo(userId: string, { title, body, path }: OutgoingMessage): Promise<number> {
    const all = devices(userId).all();
    const subscriptions = all.filter((s) => isPushServiceEndpoint(s.endpoint));
    purge(all.filter((s) => !isPushServiceEndpoint(s.endpoint)).map((s) => s.id));
    if (subscriptions.length === 0) return 0;
    const vapidDetails = { subject: deps.subject, ...keys() };
    const payload = JSON.stringify({ title, body, url: path });
    const results = await Promise.allSettled(
      subscriptions.map((s) =>
        deps.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: PUSH_TTL_S,
          timeout: PUSH_TIMEOUT_MS,
          vapidDetails,
        }),
      ),
    );
    const gone = subscriptions.filter((_, i) => {
      const result = results[i];
      return result?.status === 'rejected' && isGone(result.reason);
    });
    purge(gone.map((s) => s.id));
    const failure = results.find((r) => r.status === 'rejected' && !isGone(r.reason));
    if (failure?.status === 'rejected') throw failure.reason;
    return subscriptions.length - gone.length;
  }

  return {
    publicKey: () => keys().publicKey,
    /** Nombre d'appareils abonnés du membre. */
    deviceCount: (userId: string) => devices(userId).all().length,
    /** Abonne l'appareil au membre ; un appareil déjà abonné (même `endpoint`, même autre membre) lui est réattribué. */
    subscribe(userId: string, { endpoint, keys: k }: PushSubscriptionInput, userAgent: string | null) {
      const now = new Date();
      db.insert(pushSubscriptions)
        .values({ userId, endpoint, p256dh: k.p256dh, auth: k.auth, userAgent, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId, p256dh: k.p256dh, auth: k.auth, userAgent, updatedAt: now },
        })
        .run();
    },
    /** Cet appareil est abonné pour ce membre (un appareil partagé a pu être réattribué à un autre depuis). */
    owns: (userId: string, endpoint: string) =>
      db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
        .get() !== undefined,
    /** Désabonne cet appareil, s'il est au membre (jamais celui d'un autre). */
    unsubscribe: (userId: string, endpoint: string) =>
      db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
        .run(),
    sendTo,
  };
}

export type PushService = ReturnType<typeof createPush>;

/** Envoi réel, par `web-push`. */
export const webPushSender: PushSender = sendNotification;
