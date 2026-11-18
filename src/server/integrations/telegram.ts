import { z } from 'zod';
import { httpRequest, withoutUrl } from './http.ts';

export const TELEGRAM_API_URL = 'https://api.telegram.org';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Sujet d'un groupe à sujets (`message_thread_id`). */
  threadId: number | null;
  /** Sans son : le message arrive sans notification sonore. */
  silent: boolean;
}

const MESSAGES = {
  unauthorized: 'Telegram a refusé le jeton du bot',
  not_found: 'Bot introuvable : vérifiez le jeton',
  http: 'Telegram a refusé le message : vérifiez l’identifiant du chat et que le bot y a accès',
} as const;

/**
 * Envoie un texte brut (sans mise en forme : pas d'échappement à craindre) par le bot. Le jeton est dans le chemin de
 * l'adresse : une `IntegrationError` est relancée sans `url`. `baseUrl` remplace l'hôte (tests).
 */
export function postTelegram(config: TelegramConfig, text: string, baseUrl: string = TELEGRAM_API_URL): Promise<void> {
  return withoutUrl(() =>
    httpRequest({
      service: 'Telegram',
      baseUrl,
      path: `bot${config.botToken}/sendMessage`,
      method: 'POST',
      body: {
        chat_id: config.chatId,
        text,
        disable_notification: config.silent,
        ...(config.threadId !== null && { message_thread_id: config.threadId }),
      },
      schema: z.unknown().transform(() => undefined),
      timeoutMs: 5000,
      messages: MESSAGES,
    }),
  );
}
