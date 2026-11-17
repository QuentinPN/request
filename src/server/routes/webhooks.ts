import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  WEBHOOK_SETTINGS_PATH,
  WEBHOOK_TOKEN_HEADER,
  WEBHOOK_TOKEN_PATH,
  WEBHOOK_TOKEN_QUERY,
  type WebhookResult,
  type WebhookSettings,
  webhookPath,
  webhookServices,
} from '../../shared/webhooks.ts';
import { HttpError } from '../lib/api-errors.ts';
import { requireCapability } from '../plugins/auth.ts';
import type { SyncService } from '../services/sync.ts';
import { isValidWebhookToken, regenerateWebhookToken, webhookToken } from '../services/webhooks.ts';

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Jeton reçu : en-tête, sinon paramètre `?token=` de l'adresse. */
const receivedToken = (req: FastifyRequest) =>
  asString(req.headers[WEBHOOK_TOKEN_HEADER]) ??
  asString((req.query as Record<string, unknown> | undefined)?.[WEBHOOK_TOKEN_QUERY]);

/** Adresses à coller dans Radarr/Sonarr, d'après l'adresse par laquelle le propriétaire joint l'appli. */
function settingsOf(req: FastifyRequest, token: string): WebhookSettings {
  const urlOf = (path: string) => {
    const url = new URL(path, `${req.protocol}://${req.host}`);
    url.searchParams.set(WEBHOOK_TOKEN_QUERY, token);
    return url.toString();
  };
  const urls = Object.fromEntries(webhookServices.map((s) => [s, urlOf(webhookPath(s))]));
  return { token, urls: urls as WebhookSettings['urls'] };
}

/**
 * Webhooks entrants Radarr/Sonarr, hors session et hors contrôle CSRF (exemption de ces deux routes seulement,
 * plugins/auth.ts) : le jeton est vérifié avant la lecture du corps (401 sinon). Réglages : propriétaire seulement,
 * seul endroit où le jeton est envoyé au navigateur.
 */
export function webhookRoutes(app: FastifyInstance, sync: SyncService) {
  const checkToken = async (req: FastifyRequest) => {
    if (!isValidWebhookToken(app.data, receivedToken(req))) throw new HttpError(401, 'Jeton de webhook invalide');
  };
  for (const service of webhookServices)
    app.post(
      webhookPath(service),
      { onRequest: checkToken },
      async (req): Promise<WebhookResult> => sync.handleWebhook(service, req.body),
    );

  const ownerOnly = { preHandler: requireCapability('isOwner') };
  app.get(WEBHOOK_SETTINGS_PATH, ownerOnly, async (req) => settingsOf(req, webhookToken(app.data)));
  app.post(WEBHOOK_TOKEN_PATH, ownerOnly, async (req) => settingsOf(req, regenerateWebhookToken(app.data)));
}
