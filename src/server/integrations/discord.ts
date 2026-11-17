import { z } from 'zod';
import { httpRequest, IntegrationError } from './http.ts';

export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
}

/** Limites de Discord : 1024 caractères par champ, 4096 pour la description d'un embed. */
export const DISCORD_FIELD_MAX = 1024;
export const DISCORD_DESCRIPTION_MAX = 4096;

/** Coupe un texte trop long avec une ellipse. */
export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const MESSAGES = {
  unauthorized: 'Discord a refusé ce webhook',
  not_found: 'Webhook introuvable : a-t-il été supprimé dans Discord ?',
} as const;

/**
 * Poste un message dans le salon du webhook. La réponse de Discord (204, vide) n'a rien à valider. `baseUrl`
 * remplace l'hôte (tests) : le chemin, qui porte l'identifiant et le jeton du webhook, reste celui de l'adresse.
 * Une `IntegrationError` levée ici est relancée sans `url`, qui porterait le jeton du webhook.
 */
export async function postDiscord(
  webhookUrl: string,
  embed: DiscordEmbed,
  options: { baseUrl?: string } = {},
): Promise<void> {
  const url = new URL(webhookUrl);
  try {
    await sendDiscord(url, embed, options.baseUrl);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    throw new IntegrationError(error.kind, error.service, error.message, { status: error.status });
  }
}

function sendDiscord(url: URL, embed: DiscordEmbed, baseUrl: string | undefined) {
  return httpRequest({
    service: 'Discord',
    baseUrl: new URL(baseUrl ?? url).origin,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    method: 'POST',
    // `allowed_mentions` vide : un titre ou un motif ne peut pas mentionner @everyone.
    body: { embeds: [embed], allowed_mentions: { parse: [] } },
    schema: z.unknown(),
    timeoutMs: 5000,
    messages: MESSAGES,
  });
}
