import { z } from 'zod';
import { issueStatusSchema, issueTypeSchema } from './issues.ts';
import { mediaTypeSchema } from './media.ts';
import { agentEventKinds } from './notifications.ts';
import { settingsPathOf } from './settings-path.ts';
import { requestStatusSchema } from './status.ts';

/**
 * Agents de notification (propriétaire seulement) : des services qui reçoivent un message par évènement d'une demande
 * ou d'un signalement (et non un par destinataire). Chacun est un réglage `settingSchemas[clé]` : activé, évènements choisis, et sa
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
 * Corps JSON envoyé (POST) par le webhook sortant, toujours ces sept champs. `type` : l'évènement
 * (`agentEventKinds`), ou `test` pour l'essai du propriétaire (alors `media`, `request`, `issue` et `user` valent
 * `null`). `message` : phrases en français, séparées par des retours à la ligne. `media.title` est `null` si TMDB
 * ne répond pas. `request` : la demande des évènements de demande (`null` pour un signalement). `issue` : le
 * signalement des évènements `issue_opened` et `issue_resolved` (`null` pour une demande). `user` : le membre qui
 * a demandé (évènement de demande), qui a signalé (`issue_opened`) ou qui a résolu (`issue_resolved`, pas
 * forcément l'auteur).
 */
export const outgoingWebhookPayloadSchema = z.object({
  type: z.enum([...agentEventKinds, 'test']),
  title: z.string(),
  message: z.string(),
  media: z.object({ type: mediaTypeSchema, tmdbId: z.number().int(), title: z.string().nullable() }).nullable(),
  request: z.object({ id: z.number().int(), status: requestStatusSchema }).nullable(),
  user: z.object({ name: z.string() }).nullable(),
  issue: z.object({ id: z.number().int(), type: issueTypeSchema, status: issueStatusSchema }).nullable(),
});
export type OutgoingWebhookPayload = z.output<typeof outgoingWebhookPayloadSchema>;
