import { z } from 'zod';

export const API_VERSION_PATH = '/api/version';

/** Version du contrat de l'API pour les clients natifs (semver), indépendante de la version du paquet. */
export const API_VERSION = '1.0.0';

/**
 * Capacités de l'API que les clients natifs testent. Chaque PR qui ajoute une capacité attendue par un client ajoute
 * son nom ici, en kebab-case `domaine.capacite`.
 */
export const API_FEATURES = ['api.version'] as const;

export const apiVersionSchema = z.object({
  apiVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  features: z.array(z.string()),
});
export type ApiVersion = z.infer<typeof apiVersionSchema>;
