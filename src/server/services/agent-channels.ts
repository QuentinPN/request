import type { AgentKey, OutgoingWebhookPayload } from '../../shared/agents.ts';
import type { IssueStatus, IssueType } from '../../shared/issues.ts';
import type { MediaType } from '../../shared/media.ts';
import type { AgentEventKind } from '../../shared/notifications.ts';
import type { Setting } from '../../shared/settings.ts';
import type { RequestStatus } from '../../shared/status.ts';
import {
  DISCORD_DESCRIPTION_MAX,
  DISCORD_FIELD_MAX,
  type DiscordEmbed,
  postDiscord,
  truncate,
} from '../integrations/discord.ts';
import { postNtfy } from '../integrations/ntfy.ts';
import { postWebhook } from '../integrations/outgoing-webhook.ts';
import { postTelegram } from '../integrations/telegram.ts';

/** Ce que reçoit un agent : l'évènement d'une demande ou d'un signalement (ou l'essai du propriétaire), rendu une fois pour tous. */
export interface AgentMessage {
  kind: AgentEventKind | 'test';
  /** Titre court : « Demande approuvée ». */
  title: string;
  /** Texte libre à la place du titre concerné (essai) ; `null` pour un évènement. */
  note: string | null;
  /** Titre concerné ; `title`, `year` et `posterUrl` manquent si TMDB ne répond pas. */
  media: {
    type: MediaType;
    tmdbId: number;
    title: string | null;
    year: number | null;
    posterUrl: string | null;
  } | null;
  /** La demande d'un évènement de demande ; `null` pour un signalement. */
  request: { id: number; status: RequestStatus } | null;
  /** Le signalement d'un évènement de signalement ; `null` pour une demande. */
  issue: { id: number; type: IssueType; status: IssueStatus } | null;
  /** Le membre concerné, avec ce qu'il a fait (`label` : « Demandé par », « Signalé par », « Résolu par »). */
  user: { name: string; label: string } | null;
  /** Motif du refus, raison de l'échec, nature du problème signalé. */
  detail: { label: string; value: string } | null;
  at: Date;
}

/** Un canal : son nom dans le journal, et l'envoi d'un message avec le réglage de l'agent. */
export interface AgentChannel<K extends AgentKey = AgentKey> {
  label: string;
  send(config: Setting<K>, message: AgentMessage): Promise<void>;
}

/** Un champ que le réglage exige activé : jamais absent quand `enabled` (voir `agent` dans `shared/settings.ts`). */
function need<T>(value: T | null): T {
  if (value === null) throw new Error('Réglage incomplet');
  return value;
}

const mediaLine = ({ title, year }: NonNullable<AgentMessage['media']>) =>
  title ? `${title}${year ? ` (${year})` : ''}` : 'Titre inconnu';

/** Texte brut de l'évènement (ntfy, Telegram, `message` du webhook) : titre concerné, demandeur, motif ou raison. */
export function agentText({ media, note, user, detail }: AgentMessage): string {
  return [
    media ? mediaLine(media) : note,
    user && `${user.label} ${user.name}`,
    detail && `${detail.label} : ${detail.value}`,
  ]
    .filter((line) => line)
    .join('\n');
}

const COLORS: Record<AgentMessage['kind'], number> = {
  requested: 0xf0b232,
  approved: 0x3ba55d,
  auto_approved: 0x3ba55d,
  declined: 0xed4245,
  available: 0x3ba55d,
  failed: 0xed4245,
  cancelled: 0x747f8d,
  issue_opened: 0xf0b232,
  issue_resolved: 0x3ba55d,
  test: 0x5865f2,
};

function discordEmbed(message: AgentMessage): DiscordEmbed {
  const { media } = message;
  const description = media
    ? media.title
      ? `**${media.title}**${media.year ? ` (${media.year})` : ''}`
      : mediaLine(media)
    : (message.note ?? '');
  const fields = [
    ...(message.user
      ? [{ name: message.user.label, value: truncate(message.user.name, DISCORD_FIELD_MAX), inline: true }]
      : []),
    ...(message.detail
      ? [{ name: message.detail.label, value: truncate(message.detail.value, DISCORD_FIELD_MAX) }]
      : []),
  ];
  return {
    title: message.title,
    description: truncate(description, DISCORD_DESCRIPTION_MAX),
    color: COLORS[message.kind],
    timestamp: message.at.toISOString(),
    ...(fields.length > 0 && { fields }),
    // Les images de TMDB sont publiques ; /api/images exige une session que Discord n'a pas.
    ...(media?.posterUrl && { thumbnail: { url: media.posterUrl } }),
  };
}

/**
 * Les canaux, un par agent. `urls` remplace l'hôte de Discord et de Telegram (tests) ; ntfy et le webhook sortant
 * n'ont que l'adresse saisie par le propriétaire.
 */
export function createChannels(urls: { discord?: string; telegram?: string } = {}): {
  [K in AgentKey]: AgentChannel<K>;
} {
  return {
    discord: {
      label: 'Discord',
      send: (config, message) =>
        postDiscord(need(config.webhookUrl), discordEmbed(message), urls.discord ? { baseUrl: urls.discord } : {}),
    },
    ntfy: {
      label: 'ntfy',
      send: (config, message) =>
        postNtfy({ ...config, topic: need(config.topic) }, { title: message.title, message: agentText(message) }),
    },
    telegram: {
      label: 'Telegram',
      send: (config, message) =>
        postTelegram(
          {
            botToken: need(config.botToken),
            chatId: need(config.chatId),
            threadId: config.threadId,
            silent: config.silent,
          },
          `${message.title}\n${agentText(message)}`,
          urls.telegram,
        ),
    },
    outgoingWebhook: {
      label: 'webhook sortant',
      send: (config, message) =>
        postWebhook(need(config.url), config.authorization, {
          type: message.kind,
          title: message.title,
          message: agentText(message),
          media: message.media && {
            type: message.media.type,
            tmdbId: message.media.tmdbId,
            title: message.media.title,
          },
          request: message.request,
          user: message.user && { name: message.user.name },
          issue: message.issue,
        } satisfies OutgoingWebhookPayload),
    },
  };
}
