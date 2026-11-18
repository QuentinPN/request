import { z } from 'zod';
import { blockedKeywordSchema } from './blocklist.ts';
import { requestNotificationKinds } from './notifications.ts';
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
export type MinimumAvailability = (typeof minimumAvailabilities)[number];
/** Disponibilité minimale d'un serveur Radarr qui n'en précise pas. */
export const DEFAULT_MINIMUM_AVAILABILITY: MinimumAvailability = 'released';
/** Type de série par défaut envoyé à Sonarr. */
export const seriesTypes = ['standard', 'anime', 'daily'] as const;
export type SeriesType = (typeof seriesTypes)[number];
/** Type de série d'un serveur Sonarr (ou d'une demande) qui n'en précise pas. */
export const DEFAULT_SERIES_TYPE: SeriesType = 'standard';

/** Adresse et clé d'un service, une fois validées. */
export type ServiceConnection = z.output<typeof service>;

/** Serveur multimédia unique de l'appli : connexion des membres, disponibilité, « Regarder dans… ». */
export const mediaServerKinds = ['emby', 'jellyfin', 'plex'] as const;
export type MediaServerKind = (typeof mediaServerKinds)[number];
/** Nom affiché du serveur choisi (« Regarder dans Jellyfin ») : la seule définition. */
export const mediaServerKindLabels: Record<MediaServerKind, string> = {
  emby: 'Emby',
  jellyfin: 'Jellyfin',
  plex: 'Plex',
};
/** Nom précédé de « de », élidé devant une voyelle : « d’Emby », « de Jellyfin », « de Plex ». */
export const ofMediaServer = (kind: MediaServerKind) => {
  const name = mediaServerKindLabels[kind];
  return /^[aeiouy]/i.test(name) ? `d’${name}` : `de ${name}`;
};
const mediaServerKind = z.enum(mediaServerKinds);

/**
 * Connexion seule (adresse et clé) : ce que le test de connexion de l'assistant vérifie. Radarr et Sonarr n'en font
 * pas partie : ce sont des serveurs (`shared/arr-servers.ts`), testés par leur propre route.
 */
export const connectionSchemas = {
  mediaServer: service.extend({ kind: mediaServerKind }),
  tmdb: z.object({ apiKey }),
} as const;

export type IntegrationKey = keyof typeof connectionSchemas;
export const integrationKeys = Object.keys(connectionSchemas) as IntegrationKey[];
export type Connection<K extends IntegrationKey> = z.output<(typeof connectionSchemas)[K]>;

const defaultQuota = { limit: 10, days: 7 };

/**
 * Connexion à un serveur multimédia (Emby, Jellyfin ou Plex). `apiKey` : clé d'API d'Emby ou de Jellyfin, jeton
 * `X-Plex-Token` du propriétaire pour Plex ; `libraryIds` : bibliothèques (sections Plex) prises en compte.
 */
const mediaServer = service.extend({
  libraryIds: z.array(z.string().min(1)).default([]),
  /** Adresse pour les membres (« Regarder dans… ») : souvent différente de celle que joint le serveur. Pas un secret. */
  publicUrl: url.nullable().default(null),
});

/** Sécurité de la connexion SMTP : aucune, STARTTLS (port 587) ou TLS implicite (port 465). */
export const smtpSecurities = ['none', 'starttls', 'tls'] as const;

/** Une seule définition des réglages : validée côté serveur, réutilisée par les formulaires. */
export const settingSchemas = {
  /** Ancien réglage d'Emby, relu comme `mediaServer` de type `emby` tant que celui-ci n'existe pas (`getMediaServer`). */
  emby: mediaServer,
  mediaServer: mediaServer.extend({
    kind: mediaServerKind,
    /**
     * Id de l'instance (`Id` d'Emby/Jellyfin, `machineIdentifier` de Plex), lu par le serveur au test de chaque
     * enregistrement, jamais repris du client : figé une fois des membres inscrits. Absent des anciennes installations.
     */
    serverId: z.string().min(1).optional(),
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
      events: z.array(z.enum(requestNotificationKinds)).default([...requestNotificationKinds]),
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
  /** Envoi des notifications par courriel. `from` : expéditeur, adresse seule ou `"Nom" <adresse>`. */
  smtp: z.object({
    enabled: z.boolean().default(true),
    host: z.string().trim().min(1, 'Hôte requis'),
    port: z.number().int().min(1).max(65535).default(587),
    security: z.enum(smtpSecurities).default('starttls'),
    username: z.string().trim().min(1).nullable().default(null),
    password: z.string().min(1).nullable().default(null),
    from: z.string().trim().min(1, 'Expéditeur requis'),
  }),
  /** Clés VAPID des notifications push, générées par le serveur, jamais saisies. La publique va aux navigateurs. */
  vapid: z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }),
  /** Import des listes Trakt : `client_id` d'une application Trakt créée par le propriétaire. */
  trakt: z.object({ clientId: z.string().trim().min(1, 'Client ID requis') }),
  /** Rangées de Découvrir (appliqué par le serveur) : masquer les titres disponibles, déjà demandés. */
  discover: z.object({
    hideAvailable: z.boolean().default(false),
    hideRequested: z.boolean().default(false),
  }),
  /** Mots-clés TMDB bloqués : rangées Découvrir filtrées (`without_keywords`), demande refusée par le serveur. */
  blockedKeywords: z.object({ keywords: z.array(blockedKeywordSchema).default([]) }),
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
  mediaServer: ['apiKey'],
  tmdb: ['apiKey'],
  discord: ['webhookUrl'],
  rules: [],
  webhooks: ['token'],
  smtp: ['password'],
  vapid: ['privateKey'],
  trakt: ['clientId'],
  discover: [],
  blockedKeywords: [],
} as const satisfies { [K in SettingKey]: readonly (keyof Setting<K>)[] };

export type SecretField<K extends SettingKey> = (typeof secretFields)[K][number];

/** Réglage tel qu'envoyé au navigateur : chaque secret remplacé par `{ set }` (renseigné ou non), jamais sa valeur. */
export type MaskedSetting<K extends SettingKey> = Omit<Setting<K>, SecretField<K>> & {
  [F in SecretField<K>]: { set: boolean };
};
