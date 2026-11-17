import { z } from 'zod';
import { notificationKinds } from './notifications.ts';
import { quotaRuleSchema } from './roles.ts';

/** Adresse d'un service telle qu'enregistrée : sans `/` final. */
export const normalizeUrl = (u: string) => u.replace(/\/+$/, '');
const url = z.url({ protocol: /^https?$/ }).transform(normalizeUrl);
const apiKey = z.string().trim().min(1, 'Clé d’API requise');
const service = z.object({ url, apiKey });
/** Adresse et clé d'un service ; aussi la connexion de l'import Seerr (`shared/import.ts`), jamais enregistrée. */
export const serviceConnectionSchema = service;
/** Profil de qualité et dossier racine : réglages Radarr/Sonarr, et choix de l'approbateur avant envoi. */
export const profileId = z.number().int().positive('Profil requis');
export const rootFolderPath = z.string().trim().min(1, 'Dossier racine requis');

/** Hôtes des webhooks Discord (`discordapp.com` : l'ancien nom de domaine, toujours accepté par Discord). */
const DISCORD_HOSTS = ['discord.com', 'discordapp.com'];
const isDiscordWebhook = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { hostname, pathname } = new URL(value);
  return DISCORD_HOSTS.includes(hostname) && pathname.startsWith('/api/webhooks/');
};

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
  emby: service.extend({
    libraryIds: z.array(z.string().min(1)).default([]),
    /** Adresse d'Emby pour les membres (« Regarder dans Emby ») : souvent différente de celle que joint le serveur. Pas un secret. */
    publicUrl: url.nullable().default(null),
  }),
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
  /** Notifications Discord, facultatives : rien n'est envoyé tant que `enabled` est faux ou l'adresse absente. */
  discord: z
    .object({
      webhookUrl: z
        .url({ protocol: /^https$/ })
        .refine(isDiscordWebhook, 'Adresse attendue : https://discord.com/api/webhooks/…')
        .nullable()
        .default(null),
      enabled: z.boolean().default(false),
      events: z.array(z.enum(notificationKinds)).default([...notificationKinds]),
    })
    .refine((d) => !d.enabled || d.webhookUrl !== null, {
      message: 'Adresse du webhook requise',
      path: ['webhookUrl'],
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
  /** Jeton des webhooks entrants Radarr/Sonarr, généré par le serveur (`services/webhooks.ts`), jamais saisi. */
  webhooks: z.object({ token: z.string().min(32) }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Setting<K extends SettingKey> = z.output<(typeof settingSchemas)[K]>;
export type SettingInput<K extends SettingKey> = z.input<(typeof settingSchemas)[K]>;

/**
 * Champs chiffrés en base et jamais renvoyés au navigateur, sauf le jeton des webhooks, montré au seul propriétaire pour
 * être collé dans Radarr/Sonarr (`routes/webhooks.ts`).
 */
export const secretFields = {
  emby: ['apiKey'],
  radarr: ['apiKey'],
  sonarr: ['apiKey'],
  tmdb: ['apiKey'],
  discord: ['webhookUrl'],
  rules: [],
  webhooks: ['token'],
} as const satisfies { [K in SettingKey]: readonly (keyof Setting<K>)[] };

export type SecretField<K extends SettingKey> = (typeof secretFields)[K][number];

/** Réglage tel qu'envoyé au navigateur : chaque secret remplacé par `{ set }` (renseigné ou non), jamais sa valeur. */
export type MaskedSetting<K extends SettingKey> = Omit<Setting<K>, SecretField<K>> & {
  [F in SecretField<K>]: { set: boolean };
};
