import { z } from 'zod';
import type { OutgoingWebhookPayload } from '../../shared/agents.ts';
import { httpRequest, withoutUrl } from './http.ts';

const MESSAGES = {
  unauthorized: 'Le webhook a refusé l’en-tête Authorization',
  not_found: 'Adresse du webhook introuvable',
} as const;

/**
 * POST JSON du webhook sortant. La réponse est ignorée (texte, JSON ou vide : seul le statut compte).
 * `authorization` : valeur de l'en-tête `Authorization`, telle que saisie (« Bearer … »). L'adresse peut porter un
 * jeton (chemin, paramètre) : une `IntegrationError` est relancée sans `url`.
 */
export function postWebhook(
  webhookUrl: string,
  authorization: string | null,
  payload: OutgoingWebhookPayload,
): Promise<void> {
  const url = new URL(webhookUrl);
  return withoutUrl(() =>
    httpRequest({
      service: 'Webhook',
      baseUrl: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: 'POST',
      ...(authorization && { headers: { authorization } }),
      body: payload,
      responseType: 'text',
      schema: z.string().transform(() => undefined),
      timeoutMs: 5000,
      messages: MESSAGES,
    }),
  );
}
