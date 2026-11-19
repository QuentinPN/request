import type { MediaType } from './media.ts';
import type { AgentEventKind } from './notifications.ts';
import { settingsPathOf } from './settings-path.ts';
import type { RequestStatus } from './status.ts';

/**
 * Agents de notification (propriétaire seulement) : des services qui reçoivent un message par évènement d'une demande
 * (et non un par destinataire). Chacun est un réglage `settingSchemas[clé]` : activé, évènements choisis, et sa
 * configuration.
 */
export const agentKeys = ['discord', 'ntfy', 'telegram', 'outgoingWebhook'] as const;
export type AgentKey = (typeof agentKeys)[number];

/** `webhooks` désigne déjà les webhooks entrants de Radarr/Sonarr : celui-ci s'appelle `outgoing-webhook`. */
const SEGMENTS: Record<AgentKey, string> = {
  discord: 'discord',
  ntfy: 'ntfy',
  telegram: 'telegram',
  outgoingWebhook: 'outgoing-webhook',
};

/** Lecture et enregistrement du réglage d'un agent, et son message de test (`POST …/test`). */
export const agentSettingsPath = (key: AgentKey) => settingsPathOf(SEGMENTS[key]);
export const agentTestPath = (key: AgentKey) => `${agentSettingsPath(key)}/test`;

/** Champs sans lesquels un agent activé ne peut rien envoyer, avec le message affiché quand ils manquent. */
export const agentRequired = {
  discord: { webhookUrl: 'Adresse du webhook requise' },
  ntfy: { topic: 'Sujet requis' },
  telegram: { botToken: 'Jeton du bot requis', chatId: 'Identifiant du chat requis' },
  outgoingWebhook: { url: 'Adresse requise' },
} as const satisfies Record<AgentKey, Record<string, string>>;

/** Serveur ntfy par défaut (le service public). */
export const NTFY_DEFAULT_URL = 'https://ntfy.sh';

/**
 * Corps JSON envoyé (POST) par le webhook sortant, toujours ces six champs. `type` : l'évènement (`AgentEventKind`),
 * ou `test` pour l'essai du propriétaire (alors `media`, `request` et `user` valent `null`). `message` : phrases en
 * français, séparées par des retours à la ligne. `media.title` est `null` si TMDB ne répond pas.
 */
export interface OutgoingWebhookPayload {
  type: AgentEventKind | 'test';
  title: string;
  message: string;
  media: { type: MediaType; tmdbId: number; title: string | null } | null;
  request: { id: number; status: RequestStatus } | null;
  user: { name: string } | null;
}
