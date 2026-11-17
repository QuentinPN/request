import { z } from 'zod';

/** Services qui appellent l'appli par webhook (Réglages › Connexions › Webhook de Radarr et Sonarr). */
export const webhookServices = ['radarr', 'sonarr'] as const;
export type WebhookService = (typeof webhookServices)[number];
export const webhookServiceSchema = z.enum(webhookServices);

/** Adresse du webhook entrant d'un service : la seule route ouverte sans session ni en-tête CSRF, avec le jeton. */
export const webhookPath = (service: WebhookService) => `/api/webhooks/${service}`;

/**
 * Jeton du webhook : en paramètre `?token=` de l'adresse (accepté par toutes les versions de Radarr/Sonarr), ou dans
 * cet en-tête (champ « Headers » des versions récentes, qui le garde hors des journaux d'accès).
 */
export const WEBHOOK_TOKEN_QUERY = 'token';
export const WEBHOOK_TOKEN_HEADER = 'x-webhook-token';

/** Réglages des webhooks (propriétaire seulement) : lecture, et régénération du jeton (l'ancien cesse aussitôt). */
export const WEBHOOK_SETTINGS_PATH = '/api/settings/webhooks';
export const WEBHOOK_TOKEN_PATH = `${WEBHOOK_SETTINGS_PATH}/token`;

export interface WebhookSettings {
  /** Jeton commun aux deux services ; secret, réservé au propriétaire. */
  token: string;
  /** Adresse complète à coller dans Radarr/Sonarr, jeton compris (`?token=`), d'après l'adresse de l'appli. */
  urls: Record<WebhookService, string>;
}

/** Réponse d'un webhook (toujours 200 une fois le jeton accepté) : `handled: false` = évènement ignoré. */
export interface WebhookResult {
  handled: boolean;
}
