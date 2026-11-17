import { z } from 'zod';
import type { MediaType } from './media.ts';
import { minimumAvailabilities, profileId, rootFolderPath, seriesTypes, serviceConnectionSchema } from './settings.ts';

/** Gestionnaires de téléchargement : Radarr pour les films, Sonarr pour les séries. */
export const arrKinds = ['radarr', 'sonarr'] as const;
export type ArrKind = (typeof arrKinds)[number];
export const arrKindSchema = z.enum(arrKinds);

export const arrKindLabels: Record<ArrKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr' };
export const isArrKind = (key: string): key is ArrKind => (arrKinds as readonly string[]).includes(key);

/** Service qui reçoit un titre : Radarr pour un film, Sonarr pour une série. */
export const arrKindOf = (type: MediaType): ArrKind => (type === 'movie' ? 'radarr' : 'sonarr');

/** « Radarr », « Sonarr 4K » : le service tel que le lisent l'approbateur et le membre. */
export const arrLabel = (kind: ArrKind, is4k = false) => `${arrKindLabels[kind]}${is4k ? ' 4K' : ''}`;

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

/** Serveurs Radarr/Sonarr (propriétaire seulement) : liste, ajout, `/:id` modification et suppression, `/test`. */
export const ARR_SERVERS_PATH = '/api/arr-servers';
export const ARR_SERVERS_TEST_PATH = `${ARR_SERVERS_PATH}/test`;

/**
 * Test de connexion d'un serveur. `id` : serveur déjà enregistré dont la clé est reprise si elle est laissée vide (même
 * adresse seulement, comme pour les réglages).
 */
export const arrServerTestSchema = serviceConnectionSchema.extend({
  type: arrKindSchema,
  id: z.number().int().positive().optional(),
});
export type ArrServerTestInput = z.input<typeof arrServerTestSchema>;

export const arrServerIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** Serveur tel que le voit un approbateur : ni adresse ni clé. */
export type ArrServerSummary = Pick<ArrServer, 'id' | 'name' | 'is4k' | 'isDefault'>;
