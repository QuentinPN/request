import { and, eq } from 'drizzle-orm';
import type { RequestNotificationKind } from '../../shared/notifications.ts';
import type { Data } from '../db/index.ts';
import { media, requestEvents, requests, users } from '../db/schema.ts';
import {
  DISCORD_DESCRIPTION_MAX,
  DISCORD_FIELD_MAX,
  type DiscordEmbed,
  postDiscord,
  truncate,
} from '../integrations/discord.ts';
import { IntegrationError } from '../integrations/http.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { DEFAULT_UPSTREAM as TMDB_IMAGES_URL } from './images.ts';
import { notificationMessage, type RequestEventFact } from './notifications.ts';
import { getSetting } from './settings.ts';
import { loadSummaries } from './tmdb.ts';

const COLORS: Record<RequestNotificationKind | 'test', number> = {
  requested: 0xf0b232,
  approved: 0x3ba55d,
  declined: 0xed4245,
  available: 0x3ba55d,
  failed: 0xed4245,
  test: 0x5865f2,
};

/** Libellé du détail de l'évènement dans le message (motif du refus, raison de l'échec). */
const DETAIL_LABELS: Partial<Record<RequestNotificationKind, string>> = { declined: 'Motif', failed: 'Raison' };

/** Un échec d'envoi se journalise sans adresse : le jeton du webhook est dans son chemin. */
const logFailure = (error: unknown) =>
  console.error(
    'Notification Discord non envoyée',
    error instanceof IntegrationError ? `${error.kind}${error.status ? ` ${error.status}` : ''}` : 'erreur inattendue',
  );

/**
 * Notifications Discord, facultatives : un message par évènement (pas par destinataire), envoyé après la validation de
 * la transaction, sans attendre (l'action du membre n'en dépend jamais) et sans nouvelle tentative. Désactivé ou sans
 * adresse, rien ne part : ni Discord, ni TMDB.
 */
export function createDiscord(data: Data, deps: { tmdb: () => TmdbClient; baseUrl?: string }) {
  const { db, cryptoKey } = data;
  const send = (webhookUrl: string, embed: DiscordEmbed) =>
    postDiscord(webhookUrl, embed, deps.baseUrl ? { baseUrl: deps.baseUrl } : {});

  /** L'évènement est bien en base (la transaction n'a pas été annulée), avec le titre et le demandeur. */
  const committed = ({ requestId, type, at }: RequestEventFact) =>
    db
      .select({ detail: requestEvents.detail, type: media.type, tmdbId: media.tmdbId, requester: users.name })
      .from(requestEvents)
      .innerJoin(requests, eq(requests.id, requestEvents.requestId))
      .innerJoin(media, eq(media.id, requests.mediaId))
      .innerJoin(users, eq(users.id, requests.userId))
      .where(and(eq(requestEvents.requestId, requestId), eq(requestEvents.type, type), eq(requestEvents.createdAt, at)))
      .get();

  async function deliver(event: RequestEventFact) {
    const kind = event.type as RequestNotificationKind;
    const config = getSetting(db, cryptoKey, 'discord');
    if (!config?.enabled || !config.webhookUrl || !config.events.includes(kind)) return;
    const row = committed(event);
    if (!row) return;
    const summary = (await loadSummaries(deps.tmdb, [{ type: row.type, tmdbId: row.tmdbId }])).values().next().value;
    const title = summary?.title ?? null;
    const label = DETAIL_LABELS[kind];
    const fields = [
      { name: 'Demandé par', value: truncate(row.requester, DISCORD_FIELD_MAX), inline: true },
      ...(label && row.detail ? [{ name: label, value: truncate(row.detail, DISCORD_FIELD_MAX) }] : []),
    ];
    await send(config.webhookUrl, {
      title: notificationMessage(kind, { title, requesterName: row.requester, detail: row.detail }).title,
      description: truncate(
        title ? `**${title}**${summary?.year ? ` (${summary.year})` : ''}` : 'Titre inconnu',
        DISCORD_DESCRIPTION_MAX,
      ),
      color: COLORS[kind],
      timestamp: event.at.toISOString(),
      fields,
      // Les images de TMDB sont publiques ; /api/images exige une session que Discord n'a pas.
      ...(summary?.posterPath && { thumbnail: { url: `${TMDB_IMAGES_URL}/w342${summary.posterPath}` } }),
    });
  }

  const pending = new Set<Promise<void>>();
  /** Planifie l'envoi après la transaction en cours (synchrone) ; ne lève jamais. */
  function enqueue(event: RequestEventFact) {
    const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => deliver(event))
      .catch(logFailure)
      .finally(() => pending.delete(task));
    pending.add(task);
  }

  return {
    enqueue,
    /** Résolu quand les envois planifiés sont terminés (fermeture de l'appli, tests). */
    async idle() {
      while (pending.size > 0) await Promise.all(pending);
    },
    /** Message de test vers cette adresse ; `IntegrationError` (message lisible) si Discord la refuse. */
    test: (webhookUrl: string) =>
      send(webhookUrl, {
        title: 'Test de Request',
        description: 'Le webhook fonctionne : les notifications choisies arriveront dans ce salon.',
        color: COLORS.test,
      }),
  };
}

export type DiscordService = ReturnType<typeof createDiscord>;
