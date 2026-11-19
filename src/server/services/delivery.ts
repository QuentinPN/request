import { inArray } from 'drizzle-orm';
import { notificationPath } from '../../shared/notifications.ts';
import type { Data } from '../db/index.ts';
import { pushSubscriptions, users } from '../db/schema.ts';
import type { AfterCommit } from './after-commit.ts';
import type { EmailService } from './email.ts';
import type { CreatedNotifications, NotificationService } from './notifications.ts';
import type { PushService } from './push.ts';

/** Contenu d'une notification envoyée hors de l'appli : titre court, phrase, chemin dans l'appli. */
export interface OutgoingMessage {
  title: string;
  body: string;
  path: string;
}

/** Message des « Envoyer un essai » (courriel, push) : il renvoie vers Compte, où se règlent les notifications. */
export const testMessage = (appTitle: string, body: string): OutgoingMessage => ({
  title: `Essai de ${appTitle}`,
  body,
  path: '/compte',
});

/**
 * Distribution des notifications de l'appli (`notify`) par courriel et en push, à chaque destinataire selon ses
 * préférences (`users.email_notifications`, `push_notifications`), son adresse et ses appareils abonnés. Tout passe
 * par `AfterCommit` (après validation, sans nouvelle tentative, sans faire échouer la requête) ; chaque envoi est
 * indépendant : l'échec d'un canal ou d'un destinataire n'empêche pas les autres. Personne à prévenir hors de l'appli :
 * ni lecture du texte, ni TMDB.
 */
export function createDelivery(
  data: Data,
  deps: { afterCommit: AfterCommit; notifications: NotificationService; email: EmailService; push: PushService },
) {
  const { db } = data;
  const { afterCommit, email, push } = deps;

  async function deliver(created: CreatedNotifications) {
    const ids = created.rows.map((r) => r.userId);
    // Courriel : seulement les types que le propriétaire a cochés (`smtp.events`), en plus du choix du membre.
    const config = email.active();
    const smtp = config?.events.includes(created.kind) ? config : null;
    const people = db
      .select({
        id: users.id,
        email: users.email,
        wantsEmail: users.emailNotifications,
        wantsPush: users.pushNotifications,
      })
      .from(users)
      .where(inArray(users.id, ids))
      .all();
    const withDevice = new Set(
      db
        .selectDistinct({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(inArray(pushSubscriptions.userId, ids))
        .all()
        .map((s) => s.userId),
    );
    const channels = new Map(
      people.map((p) => [
        p.id,
        { email: smtp && p.wantsEmail && p.email ? p.email : null, push: p.wantsPush && withDevice.has(p.id) },
      ]),
    );
    const reached = new Set([...channels].filter(([, c]) => c.email || c.push).map(([id]) => id));
    if (reached.size === 0) return;

    for (const { userId, view } of await deps.notifications.committed(created, reached)) {
      const to = channels.get(userId);
      const message: OutgoingMessage = { title: view.title, body: view.body, path: notificationPath(view) };
      if (smtp && to?.email) {
        const address = to.email;
        afterCommit.schedule('courriel', () => email.send(smtp, address, message));
      }
      if (to?.push) afterCommit.schedule('push', () => push.sendTo(userId, message));
    }
  }

  return {
    /** Écouteur de `onNotificationsCreated` : planifie la distribution, faite après la validation. Ne lève jamais. */
    enqueue: (created: CreatedNotifications) => afterCommit.schedule('courriel ou push', () => deliver(created)),
  };
}
