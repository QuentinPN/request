import { z } from 'zod';
import { minimumAvailabilities, profileId, rootFolderPath, seriesTypes, serviceConnectionSchema } from './settings.ts';

/** Gestionnaires de téléchargement : Radarr pour les films, Sonarr pour les séries. */
export const arrKinds = ['radarr', 'sonarr'] as const;
export type ArrKind = (typeof arrKinds)[number];
export const arrKindSchema = z.enum(arrKinds);

export const arrKindLabels: Record<ArrKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr' };

/**
 * Serveur Radarr ou Sonarr (table `arr_servers`). Au plus un serveur par défaut par couple (type, 4K) ; les réglages
 * de destination servent de valeurs par défaut à l'approbation. `minimumAvailability` ne concerne que Radarr,
 * `seriesType` et `languageProfileId` (Sonarr v3) que Sonarr.
 */
const arrServerFields = {
  type: arrKindSchema,
  name: z.string().trim().min(1, 'Nom requis').max(100),
  is4k: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  qualityProfileId: profileId,
  rootFolderPath,
  minimumAvailability: z.enum(minimumAvailabilities).nullable().default(null),
  seriesType: z.enum(seriesTypes).nullable().default(null),
  languageProfileId: profileId.nullable().default(null),
  /** Ids des étiquettes Radarr/Sonarr posées sur les titres envoyés. */
  tags: z.array(z.number().int().nonnegative()).default([]),
};

/** Création ou modification d'un serveur (la clé, chiffrée en base, ne revient jamais au navigateur). */
export const arrServerInputSchema = serviceConnectionSchema.extend(arrServerFields);
export type ArrServerInput = z.input<typeof arrServerInputSchema>;

/** Serveur tel qu'envoyé au navigateur : sans sa clé d'API, seulement l'indication qu'elle est renseignée. */
export const arrServerSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  apiKey: z.object({ set: z.boolean() }),
  ...arrServerFields,
});
export type ArrServer = z.output<typeof arrServerSchema>;
