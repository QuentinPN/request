import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { type AgentKey, agentKeys, agentRequired, agentSettingsPath, agentTestPath } from '../../shared/agents.ts';
import { AGENT_EVENTS_VERSION } from '../../shared/notifications.ts';
import { type MaskedSetting, type Setting, type SettingInput, settingSchemas } from '../../shared/settings.ts';
import { asTestResult, HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import type { AgentsService } from '../services/agents.ts';
import { getSetting, maskSetting, setSetting, withoutSecrets, withStoredSecrets } from '../services/settings.ts';

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Agents de notification (propriétaire seulement), un réglage et un essai chacun : lecture (secrets masqués),
 * enregistrement (secret vide = l'enregistré, vers la même destination seulement), et « Tester ». Les secrets ne
 * sortent jamais du serveur.
 */
export function agentRoutes(app: FastifyInstance, agents: AgentsService) {
  const { db, cryptoKey } = app.data;

  for (const key of agentKeys) {
    const stored = () => getSetting(db, cryptoKey, key);
    // Tous les agents partagent `enabled` et `events` : le serveur les traite sans distinguer leur configuration.
    const schema = settingSchemas[key] as z.ZodType<Setting<AgentKey>>;

    app.get(agentSettingsPath(key), ownerOnly, async (): Promise<MaskedSetting<typeof key>> => {
      return maskSetting(key, stored() ?? schema.parse({}));
    });

    app.put(agentSettingsPath(key), ownerOnly, async (req): Promise<MaskedSetting<typeof key>> => {
      const input = withStoredSecrets(key, req.body, stored());
      return maskSetting(
        key,
        setSetting(
          db,
          cryptoKey,
          key,
          parseRequest(schema, { ...(input as object), eventsVersion: AGENT_EVENTS_VERSION }) as SettingInput<
            typeof key
          >,
        ),
      );
    });

    /** Essai avec les valeurs du formulaire, complétées par l'enregistré (secrets vides compris), sans rien enregistrer. */
    app.post(agentTestPath(key), ownerOnly, async (req) => {
      const current = stored();
      const typed = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const input = withStoredSecrets(
        key,
        { ...(current && withoutSecrets(key, current)), ...typed },
        current,
      ) as Record<string, unknown>;
      for (const [field, message] of Object.entries(agentRequired[key]))
        if (isBlank(input[field])) throw new HttpError(409, message);
      const config = parseRequest(schema, { ...input, enabled: true });
      await asTestResult(() => agents.test(key, config));
      return { ok: true };
    });
  }
}
