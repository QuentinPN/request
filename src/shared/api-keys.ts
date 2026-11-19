import { z } from 'zod';
import { settingsPathOf } from './settings-path.ts';

/** En-tête d'authentification des clés d'API publiques (sans cookie, donc sans CSRF). */
export const API_KEY_HEADER = 'x-api-key';

/** Gestion des clés (propriétaire seulement, par session : une clé d'API ne peut pas en créer ni en révoquer). */
export const API_KEYS_PATH = settingsPathOf('api-keys');
/** Adresse d'une clé ; `':id'` donne le motif de la route. */
export const apiKeyPath = (id: number | ':id') => `${API_KEYS_PATH}/${id}`;

/**
 * Portée d'une clé : ce qu'elle a le droit de faire, en plus de ne jamais dépasser les droits de son créateur.
 * `read` : consulter ; `requests` : `read` plus créer, approuver et refuser des demandes ; `full` : toutes les routes
 * qu'une clé peut appeler (les clés d'avant les portées).
 */
export const apiKeyScopes = ['read', 'requests', 'full'] as const;
export const apiKeyScopeSchema = z.enum(apiKeyScopes);
export type ApiKeyScope = z.output<typeof apiKeyScopeSchema>;

export const apiKeyScopeLabels: Record<ApiKeyScope, string> = {
  read: 'Lecture',
  requests: 'Demandes',
  full: 'Complète',
};
export const apiKeyScopeDescriptions: Record<ApiKeyScope, string> = {
  read: 'Consulter le catalogue, les demandes, les signalements et les statistiques.',
  requests: 'Lecture, plus créer, approuver et refuser des demandes.',
  full: 'Tous les droits du propriétaire, sauf la gestion des clés et des sessions.',
};

/** `scope` absent : `full`, comme les clés créées avant les portées. */
export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1, 'Nom requis').max(100),
  scope: apiKeyScopeSchema.default('full'),
});
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>;

export const apiKeyIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Clé telle qu'envoyée au navigateur : jamais son hash, seulement un préfixe pour la reconnaître. La clé complète
 * n'est montrée qu'une fois, dans la réponse de sa création.
 */
export const apiKeySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  /** Nom du propriétaire qui l'a créée (ses droits actuels plafonnent ceux de la clé). */
  createdByName: z.string(),
  scope: apiKeyScopeSchema,
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
