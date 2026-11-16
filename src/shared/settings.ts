import { z } from 'zod';

const url = z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, ''));
const apiKey = z.string().trim().min(1, 'Clé d’API requise');
const service = z.object({ url, apiKey });

/** Une seule définition des réglages : validée côté serveur, réutilisée par les formulaires. */
export const settingSchemas = {
  emby: service,
  radarr: service,
  sonarr: service,
  tmdb: z.object({ apiKey }),
  discord: z.object({
    webhookUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .default(null),
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
} as const satisfies { [K in SettingKey]: readonly (keyof Setting<K>)[] };
