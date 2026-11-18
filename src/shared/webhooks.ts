import { arrKinds } from './arr-servers.ts';

/** Services qui appellent l'appli par webhook (Réglages › Connexions › Webhook de Radarr et Sonarr). */
export const webhookServices = arrKinds;
export type WebhookService = (typeof webhookServices)[number];

/** Adresse du webhook entrant d'un service : la seule route ouverte sans session ni en-tête CSRF, avec le jeton. */
export const webhookPath = (service: WebhookService) => `/api/webhooks/${service}`;

/**
 * Jeton du webhook : en paramètre `?token=` de l'adresse (accepté par toutes les versions de Radarr/Sonarr), ou dans
 * cet en-tête (champ « Headers » des versions récentes, qui le garde hors des journaux d'accès).
 */
export const WEBHOOK_TOKEN_QUERY = 'token';
/**
 * Serveur émetteur (`?server=<id>`) : seuls sa liste et sa file sont relues, et un Grab sait s'il est 4K. Absent ou
 * inconnu (adresse collée avant les serveurs multiples) : le titre est recalculé sur tous les serveurs du type.
 */
export const WEBHOOK_SERVER_QUERY = 'server';
export const WEBHOOK_TOKEN_HEADER = 'x-webhook-token';

/** Réglages des webhooks (propriétaire seulement) : lecture, et régénération du jeton (l'ancien cesse aussitôt). */
export const WEBHOOK_SETTINGS_PATH = '/api/settings/webhooks';
export const WEBHOOK_TOKEN_PATH = `${WEBHOOK_SETTINGS_PATH}/token`;

export interface WebhookSettings {
  /** Jeton commun à tous les serveurs ; secret, réservé au propriétaire. */
  token: string;
  /**
   * Une adresse par serveur Radarr/Sonarr, à coller dans ce serveur : jeton (`?token=`) et serveur (`&server=`) compris,
   * d'après l'adresse de l'appli.
   */
  servers: Array<{ id: number; name: string; type: WebhookService; is4k: boolean; url: string }>;
}

/** Réponse d'un webhook (toujours 200 une fois le jeton accepté) : `handled: false` = évènement ignoré. */
export interface WebhookResult {
  handled: boolean;
}
