import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  WEBHOOK_SERVER_QUERY,
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
import { ownerOnly } from '../plugins/auth.ts';
import { listArrServers } from '../services/arr-servers.ts';
import type { SyncService } from '../services/sync.ts';
import { isValidWebhookToken, regenerateWebhookToken, webhookToken } from '../services/webhooks.ts';

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

const queryOf = (req: FastifyRequest) => req.query as Record<string, unknown> | undefined;

/** Jeton reçu : en-tête, sinon paramètre `?token=` de l'adresse. */
const receivedToken = (req: FastifyRequest) =>
  asString(req.headers[WEBHOOK_TOKEN_HEADER]) ?? asString(queryOf(req)?.[WEBHOOK_TOKEN_QUERY]);

/** Serveur émetteur (`?server=<id>`) ; absent ou illisible : `undefined` (recalcul sur tous les serveurs du type). */
function senderOf(req: FastifyRequest): number | undefined {
  const id = Number(asString(queryOf(req)?.[WEBHOOK_SERVER_QUERY]));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Adresses à coller dans chaque serveur Radarr/Sonarr, d'après l'adresse par laquelle le propriétaire joint l'appli. */
function settingsOf(req: FastifyRequest, token: string, data: FastifyInstance['data']): WebhookSettings {
  const servers = listArrServers(data).map(({ id, name, type, is4k }) => {
    const url = new URL(webhookPath(type), `${req.protocol}://${req.host}`);
    url.searchParams.set(WEBHOOK_TOKEN_QUERY, token);
    url.searchParams.set(WEBHOOK_SERVER_QUERY, String(id));
    return { id, name, type, is4k, url: url.toString() };
  });
  return { token, servers };
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
      async (req): Promise<WebhookResult> => sync.handleWebhook(service, req.body, senderOf(req)),
    );

  app.get(WEBHOOK_SETTINGS_PATH, ownerOnly, async (req) => settingsOf(req, webhookToken(app.data), app.data));
  app.post(WEBHOOK_TOKEN_PATH, ownerOnly, async (req) => settingsOf(req, regenerateWebhookToken(app.data), app.data));
}
