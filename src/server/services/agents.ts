import { and, eq } from 'drizzle-orm';
import { type AgentKey, agentKeys } from '../../shared/agents.ts';
import type { AgentEventKind } from '../../shared/notifications.ts';
import type { Data } from '../db/index.ts';
import { media, requestEvents, requests, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import type { AfterCommit } from './after-commit.ts';
import { type AgentChannel, type AgentMessage, createChannels } from './agent-channels.ts';
import { DEFAULT_UPSTREAM as TMDB_IMAGES_URL } from './images.ts';
import { mediaServerName } from './media-server.ts';
import { type AgentRequestEvent, agentEventTitle } from './notifications.ts';
import { getAppTitle, getSetting } from './settings.ts';
import { loadSummaries } from './tmdb.ts';

/** Libellé du détail de l'évènement dans le message (motif du refus, raison de l'échec). */
const DETAIL_LABELS: Partial<Record<AgentEventKind, string>> = { declined: 'Motif', failed: 'Raison' };

/**
 * Agents de notification (Discord, ntfy, Telegram, webhook sortant), facultatifs : un message par évènement (pas par
 * destinataire), envoyé après la validation de la transaction (`AfterCommit` : sans attendre, sans nouvelle tentative).
 * Chaque agent envoie ses évènements choisis, indépendamment des autres. Aucun agent actif pour l'évènement : rien ne
 * part, TMDB n'est pas appelé non plus.
 */
export function createAgents(
  data: Data,
  deps: { tmdb: () => TmdbClient; afterCommit: AfterCommit; discordUrl?: string; telegramUrl?: string },
) {
  const { db, cryptoKey } = data;
  const channels: Record<AgentKey, AgentChannel> = createChannels({
    ...(deps.discordUrl && { discord: deps.discordUrl }),
    ...(deps.telegramUrl && { telegram: deps.telegramUrl }),
  });

  /** L'évènement est bien en base (la transaction n'a pas été annulée), avec le titre, la demande et le demandeur. */
  const committed = ({ requestId, type, at }: AgentRequestEvent) =>
    db
      .select({
        detail: requestEvents.detail,
        type: media.type,
        tmdbId: media.tmdbId,
        requester: users.name,
        status: requests.status,
      })
      .from(requestEvents)
      .innerJoin(requests, eq(requests.id, requestEvents.requestId))
      .innerJoin(media, eq(media.id, requests.mediaId))
      .innerJoin(users, eq(users.id, requests.userId))
      .where(and(eq(requestEvents.requestId, requestId), eq(requestEvents.type, type), eq(requestEvents.createdAt, at)))
      .get();

  async function render(event: AgentRequestEvent): Promise<AgentMessage | null> {
    const row = committed(event);
    if (!row) return null;
    const summary = (await loadSummaries(deps.tmdb, [{ type: row.type, tmdbId: row.tmdbId }])).values().next().value;
    const label = DETAIL_LABELS[event.kind];
    return {
      kind: event.kind,
      title: agentEventTitle(event.kind, mediaServerName(data)),
      note: null,
      media: {
        type: row.type,
        tmdbId: row.tmdbId,
        title: summary?.title ?? null,
        year: summary?.year ?? null,
        // Les images de TMDB sont publiques ; /api/images exige une session que l'agent n'a pas.
        posterUrl: summary?.posterPath ? `${TMDB_IMAGES_URL}/w342${summary.posterPath}` : null,
      },
      request: { id: event.requestId, status: row.status },
      user: { name: row.requester },
      detail: label && row.detail ? { label, value: row.detail } : null,
      at: event.at,
    };
  }

  async function deliver(event: AgentRequestEvent) {
    const wanted = agentKeys.flatMap((key) => {
      const config = getSetting(db, cryptoKey, key);
      return config?.enabled && config.events.includes(event.kind) ? [{ channel: channels[key], config }] : [];
    });
    if (wanted.length === 0) return;
    const message = await render(event);
    if (!message) return;
    // Un envoi par agent, indépendants : l'échec de l'un n'empêche ni ne retarde les autres.
    for (const { channel, config } of wanted)
      deps.afterCommit.schedule(channel.label, () => channel.send(config, message));
  }

  return {
    /** Planifie les envois après la transaction en cours (synchrone) ; ne lève jamais. */
    enqueue: (event: AgentRequestEvent) => deps.afterCommit.schedule('agents', () => deliver(event)),
    /** Résolu quand les envois planifiés (tous canaux) sont terminés (fermeture de l'appli, tests). */
    idle: deps.afterCommit.idle,
    /** Message d'essai avec ce réglage ; `IntegrationError` (message lisible) si le service le refuse. */
    test: (key: AgentKey, config: Parameters<AgentChannel['send']>[0]) =>
      channels[key].send(config, {
        kind: 'test',
        title: `Test de ${getAppTitle(db, cryptoKey)}`,
        note: 'Le test réussit : les notifications choisies arriveront ici.',
        media: null,
        request: null,
        user: null,
        detail: null,
        at: new Date(),
      }),
  };
}

export type AgentsService = ReturnType<typeof createAgents>;
