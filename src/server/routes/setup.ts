import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { arrKinds } from '../../shared/arr-servers.ts';
import {
  type Connection,
  connectionSchemas,
  type IntegrationKey,
  type MaskedSetting,
  type Setting,
  type SettingKey,
  settingSchemas,
} from '../../shared/settings.ts';
import {
  integrationKeySchema,
  type SettingSection,
  type SetupSection,
  type SetupState,
  settingSectionSchema,
  setupSections,
  type TestResults,
} from '../../shared/setup.ts';
import { listEmbyLibraries, testEmby } from '../integrations/emby.ts';
import { IntegrationError } from '../integrations/http.ts';
import { testTmdb } from '../integrations/tmdb.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { requireCapability } from '../plugins/auth.ts';
import { hasArrServer } from '../services/arr-servers.ts';
import { getSetting, maskSetting, savedKeys, setSetting, withStoredSecrets } from '../services/settings.ts';
import { hasOwner } from '../services/users.ts';

const testers: { [K in IntegrationKey]: (connection: Connection<K>) => Promise<TestResults[K]> } = {
  emby: async (connection) => {
    const [info, libraries] = await Promise.all([testEmby(connection), listEmbyLibraries(connection)]);
    return { ...info, libraries };
  },
  tmdb: testTmdb,
};

/** Un échec du service testé devient une 422 avec son message lisible (aussi pour les serveurs Radarr/Sonarr). */
export async function asTestResult<T>(test: () => Promise<T>): Promise<T> {
  try {
    return await test();
  } catch (error) {
    if (error instanceof IntegrationError) throw new HttpError(422, error.message);
    throw error;
  }
}

const runTest = <K extends IntegrationKey>(key: K, connection: Connection<K>): Promise<TestResults[K]> =>
  asTestResult(() => testers[key](connection));

const isIntegration = (key: SettingKey): key is IntegrationKey => key in connectionSchemas;

/** Paramètre `:service` validé ; inconnu → 404. */
function serviceParam<T extends string>(req: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse((req.params as { service?: unknown }).service);
  if (!parsed.success) throw new HttpError(404, 'Introuvable');
  return parsed.data;
}

/** Réservé au propriétaire ; Emby reste ouvert tant qu'aucun propriétaire n'existe (voir plugins/auth.ts). */
const ownerOnly = { preHandler: requireCapability('isOwner') };

export function setupRoutes(app: FastifyInstance) {
  const { db, cryptoKey } = app.data;

  app.get('/api/setup/state', async (): Promise<SetupState> => {
    const saved = savedKeys(db);
    for (const kind of arrKinds) if (hasArrServer(db, kind)) saved.add(kind);
    const services = Object.fromEntries(setupSections.map((s) => [s, saved.has(s)])) as Record<SetupSection, boolean>;
    const owner = hasOwner(db);
    return { services, hasOwner: owner, complete: owner && setupSections.every((s) => services[s]) };
  });

  app.post('/api/setup/:service/test', ownerOnly, async (req) => {
    const key = serviceParam(req, integrationKeySchema);
    const input = withStoredSecrets(key, req.body, getSetting(db, cryptoKey, key));
    return runTest(key, parseRequest(connectionSchemas[key] as z.ZodType<Connection<typeof key>>, input));
  });

  app.get('/api/settings/:service', ownerOnly, async (req): Promise<MaskedSetting<SettingSection>> => {
    const key = serviceParam(req, settingSectionSchema);
    // Les règles ont des valeurs par défaut ; une intégration jamais enregistrée n'a rien à montrer.
    const value = getSetting(db, cryptoKey, key) ?? (key === 'rules' ? settingSchemas.rules.parse({}) : null);
    if (!value) throw new HttpError(404, 'Pas encore configuré');
    return maskSetting(key, value);
  });

  app.put('/api/settings/:service', ownerOnly, async (req): Promise<MaskedSetting<SettingSection>> => {
    const key = serviceParam(req, settingSectionSchema);
    const input = withStoredSecrets(key, req.body, getSetting(db, cryptoKey, key));
    const value = parseRequest(settingSchemas[key] as z.ZodType<Setting<typeof key>>, input);
    if (isIntegration(key)) await runTest(key, connectionSchemas[key].parse(value) as Connection<typeof key>);
    return maskSetting(key, setSetting(db, cryptoKey, key, value));
  });
}
