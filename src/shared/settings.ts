import { z } from 'zod';
import { quotaRuleSchema } from './roles.ts';

/** Adresse d'un service telle qu'enregistrée : sans `/` final. */
export const normalizeUrl = (u: string) => u.replace(/\/+$/, '');
const url = z.url({ protocol: /^https?$/ }).transform(normalizeUrl);
const apiKey = z.string().trim().min(1, 'Clé d’API requise');
const service = z.object({ url, apiKey });
/** Profil de qualité et dossier racine : réglages Radarr/Sonarr, et choix de l'approbateur avant envoi. */
export const profileId = z.number().int().positive('Profil requis');
export const rootFolderPath = z.string().trim().min(1, 'Dossier racine requis');

/** Disponibilité minimale d'un film avant que Radarr ne le cherche. */
export const minimumAvailabilities = ['announced', 'inCinemas', 'released'] as const;
/** Type de série par défaut envoyé à Sonarr. */
export const seriesTypes = ['standard', 'anime', 'daily'] as const;

/** Connexion seule (adresse et clé) : ce que le test de connexion de l'assistant vérifie. */
export const connectionSchemas = {
  emby: service,
  radarr: service,
  sonarr: service,
  tmdb: z.object({ apiKey }),
} as const;

export type IntegrationKey = keyof typeof connectionSchemas;
export const integrationKeys = Object.keys(connectionSchemas) as IntegrationKey[];
export type Connection<K extends IntegrationKey> = z.output<(typeof connectionSchemas)[K]>;

const defaultQuota = { limit: 10, days: 7 };

/** Une seule définition des réglages : validée côté serveur, réutilisée par les formulaires. */
export const settingSchemas = {
  emby: service.extend({ libraryIds: z.array(z.string().min(1)).default([]) }),
  radarr: service.extend({
    qualityProfileId: profileId,
    rootFolderPath,
    minimumAvailability: z.enum(minimumAvailabilities).default('released'),
  }),
  sonarr: service.extend({
    qualityProfileId: profileId,
    rootFolderPath,
    seriesType: z.enum(seriesTypes).default('standard'),
    /** Sonarr v3 seulement (supprimé en v4). */
    languageProfileId: profileId.optional(),
  }),
  tmdb: connectionSchemas.tmdb,
  discord: z.object({
    webhookUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .default(null),
  }),
  /** Règles de demande : quotas par défaut, sur une fenêtre glissante (le rôle décide de l'approbation auto). */
  rules: z.object({
    defaultQuota: z
      .object({
        movies: quotaRuleSchema.default(defaultQuota),
        seasons: quotaRuleSchema.default(defaultQuota),
      })
      .default({ movies: defaultQuota, seasons: defaultQuota }),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Setting<K extends SettingKey> = z.output<(typeof settingSchemas)[K]>;
export type SettingInput<K extends SettingKey> = z.input<(typeof settingSchemas)[K]>;

/** Champs chiffrés en base et jamais renvoyés au navigateur. */
export const secretFields = {
  emby: ['apiKey'],
  radarr: ['apiKey'],
  sonarr: ['apiKey'],
  tmdb: ['apiKey'],
  discord: ['webhookUrl'],
  rules: [],
} as const satisfies { [K in SettingKey]: readonly (keyof Setting<K>)[] };

export type SecretField<K extends SettingKey> = (typeof secretFields)[K][number];

/** Réglage tel qu'envoyé au navigateur : chaque secret remplacé par `{ set }` (renseigné ou non), jamais sa valeur. */
export type MaskedSetting<K extends SettingKey> = Omit<Setting<K>, SecretField<K>> & {
  [F in SecretField<K>]: { set: boolean };
};
