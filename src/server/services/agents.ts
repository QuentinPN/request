import { and, eq } from 'drizzle-orm';
import { type AgentKey, agentKeys } from '../../shared/agents.ts';
import { issueTypeLabels } from '../../shared/issues.ts';
import type { MediaType } from '../../shared/media.ts';
import type { AgentEventKind, AgentIssueEventKind } from '../../shared/notifications.ts';
import type { Data } from '../db/index.ts';
import { issues, media, requestEvents, requests, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import type { AfterCommit } from './after-commit.ts';
import { type AgentChannel, type AgentMessage, createChannels } from './agent-channels.ts';
import { DEFAULT_UPSTREAM as TMDB_IMAGES_URL } from './images.ts';
import { mediaServerName } from './media-server.ts';
import {
  type AgentEvent,
  type AgentIssueEvent,
  type AgentRequestEvent,
  agentEventTitle,
  isAgentIssueEvent,
} from './notifications.ts';
import { getAppTitle, getSetting } from './settings.ts';
import { loadSummaries } from './tmdb.ts';

/** Libellé du détail de l'évènement dans le message (motif du refus, raison de l'échec). */
const DETAIL_LABELS: Partial<Record<AgentEventKind, string>> = { declined: 'Motif', failed: 'Raison' };

/** Ce qu'a fait le membre nommé dans le message d'un signalement (l'auteur, ou celui qui l'a résolu). */
const ISSUE_USER_LABELS: Record<AgentIssueEventKind, string> = {
  issue_opened: 'Signalé par',
  issue_resolved: 'Résolu par',
};

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

  /**
   * Le signalement est bien en base dans l'état de l'évènement (créé, ou résolu à cette date), avec son titre. Relu
   * après la validation : un signalement rouvert avant l'envoi de `issue_resolved` n'envoie rien, et `issue.status`
   * est l'état au moment de l'envoi (comme `request.status` pour une demande).
   */
  const committedIssue = ({ issueId, kind, at }: AgentIssueEvent) =>
    db
      .select({ type: media.type, tmdbId: media.tmdbId, issueType: issues.type, status: issues.status })
      .from(issues)
      .innerJoin(media, eq(media.id, issues.mediaId))
      .where(
        and(
          eq(issues.id, issueId),
          kind === 'issue_opened'
            ? eq(issues.createdAt, at)
            : and(eq(issues.status, 'resolved'), eq(issues.resolvedAt, at)),
        ),
      )
      .get();

  /** Le titre concerné, avec l'année et l'affiche de TMDB (absents s'il ne répond pas). */
  async function mediaOf(title: { type: MediaType; tmdbId: number }): Promise<NonNullable<AgentMessage['media']>> {
    const summary = (await loadSummaries(deps.tmdb, [title])).values().next().value;
    return {
      type: title.type,
      tmdbId: title.tmdbId,
      title: summary?.title ?? null,
      year: summary?.year ?? null,
      // Les images de TMDB sont publiques ; /api/images exige une session que l'agent n'a pas.
      posterUrl: summary?.posterPath ? `${TMDB_IMAGES_URL}/w342${summary.posterPath}` : null,
    };
  }

  async function renderRequest(event: AgentRequestEvent): Promise<AgentMessage | null> {
    const row = committed(event);
    if (!row) return null;
    const label = DETAIL_LABELS[event.kind];
    return {
      kind: event.kind,
      title: agentEventTitle(event.kind, mediaServerName(data)),
      note: null,
      media: await mediaOf(row),
      request: { id: event.requestId, status: row.status },
      issue: null,
      user: { name: row.requester, label: 'Demandé par' },
      detail: label && row.detail ? { label, value: row.detail } : null,
      at: event.at,
    };
  }

  async function renderIssue(event: AgentIssueEvent): Promise<AgentMessage | null> {
    const row = committedIssue(event);
    if (!row) return null;
    const actor = event.actorId
      ? db.select({ name: users.name }).from(users).where(eq(users.id, event.actorId)).get()
      : null;
    return {
      kind: event.kind,
      title: agentEventTitle(event.kind, mediaServerName(data)),
      note: null,
      media: await mediaOf(row),
      request: null,
      issue: { id: event.issueId, type: row.issueType, status: row.status },
      user: actor ? { name: actor.name, label: ISSUE_USER_LABELS[event.kind] } : null,
      detail: { label: 'Problème', value: issueTypeLabels[row.issueType] },
      at: event.at,
    };
  }

  const render = (event: AgentEvent) => (isAgentIssueEvent(event) ? renderIssue(event) : renderRequest(event));

  async function deliver(event: AgentEvent) {
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
    enqueue: (event: AgentEvent) => deps.afterCommit.schedule('agents', () => deliver(event)),
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
        issue: null,
        user: null,
        detail: null,
        at: new Date(),
      }),
  };
}

export type AgentsService = ReturnType<typeof createAgents>;
