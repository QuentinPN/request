import { z } from 'zod';

/** En-tête d'authentification des clés d'API publiques (sans cookie, donc sans CSRF). */
export const API_KEY_HEADER = 'x-api-key';

export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1, 'Nom requis').max(100) });
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>;

/**
 * Clé telle qu'envoyée au navigateur : jamais son hash, seulement un préfixe pour la reconnaître. La clé complète
 * n'est montrée qu'une fois, dans la réponse de sa création.
 */
export const apiKeySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  /** Dates ISO 8601 ; `null` : jamais utilisée, pas révoquée. */
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.output<typeof apiKeySchema>;
