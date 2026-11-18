import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DISCORD_SETTINGS_PATH, DISCORD_TEST_PATH } from '../../shared/discord.ts';
import { type MaskedSetting, settingSchemas } from '../../shared/settings.ts';
import { asTestResult, HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import type { DiscordService } from '../services/discord.ts';
import { getSetting, maskSetting, setSetting, withStoredSecrets } from '../services/settings.ts';

/** Adresse à essayer : celle saisie, sinon l'enregistrée. */
const testInputSchema = z.object({ webhookUrl: settingSchemas.discord.shape.webhookUrl.optional() });

/** Notifications Discord (propriétaire seulement) : l'adresse du webhook, un secret, ne sort jamais du serveur. */
export function discordRoutes(app: FastifyInstance, discord: DiscordService) {
  const { db, cryptoKey } = app.data;
  const stored = () => getSetting(db, cryptoKey, 'discord');

  app.get(
    DISCORD_SETTINGS_PATH,
    ownerOnly,
    async (): Promise<MaskedSetting<'discord'>> => maskSetting('discord', stored() ?? settingSchemas.discord.parse({})),
  );

  app.put(DISCORD_SETTINGS_PATH, ownerOnly, async (req): Promise<MaskedSetting<'discord'>> => {
    const input = withStoredSecrets('discord', req.body, stored());
    return maskSetting('discord', setSetting(db, cryptoKey, 'discord', parseRequest(settingSchemas.discord, input)));
  });

  app.post(DISCORD_TEST_PATH, ownerOnly, async (req) => {
    const { webhookUrl } = parseRequest(testInputSchema, req.body ?? {});
    const url = webhookUrl ?? stored()?.webhookUrl;
    if (!url) throw new HttpError(409, 'Aucun webhook enregistré');
    await asTestResult(() => discord.test(url));
    return { ok: true };
  });
}
