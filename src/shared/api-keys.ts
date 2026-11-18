import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';

/** En-tête d'authentification des clés d'API publiques (sans cookie, donc sans CSRF). */
export const API_KEY_HEADER = 'x-api-key';

/** Gestion des clés (propriétaire seulement, par session : une clé d'API ne peut pas en créer ni en révoquer). */
export const API_KEYS_PATH = settingsPathOf('api-keys');
/** Adresse d'une clé ; `':id'` donne le motif de la route. */
export const apiKeyPath = (id: number | ':id') => `${API_KEYS_PATH}/${id}`;

export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1, 'Nom requis').max(100) });

export const apiKeyIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Clé telle qu'envoyée au navigateur : jamais son hash, seulement un préfixe pour la reconnaître. La clé complète
 * n'est montrée qu'une fois, dans la réponse de sa création.
 */
export const apiKeySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  /** Nom du propriétaire qui l'a créée (ses droits actuels sont ceux de la clé). */
  createdByName: z.string(),
  /** Dates ISO 8601 ; `null` : jamais utilisée, pas révoquée. */
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.output<typeof apiKeySchema>;

/** Réponse de la création : `secret` est la clé complète, renvoyée cette seule fois. */
export interface ApiKeyCreated {
  apiKey: ApiKey;
  secret: string;
}
