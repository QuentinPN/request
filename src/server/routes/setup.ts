import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { arrKinds } from '../../shared/arr-servers.ts';
import {
  type Connection,
  connectionSchemas,
  type IntegrationKey,
  type MaskedSetting,
  mediaServerKindLabels,
  ofMediaServer,
  type Setting,
  type SettingKey,
  settingSchemas,
} from '../../shared/settings.ts';
import {
  integrationKeySchema,
  SETUP_STATE_PATH,
  type SettingSection,
  type SetupSection,
  type SetupState,
  settingPath,
  settingSectionSchema,
  setupSections,
  setupTestPath,
  type TestResults,
} from '../../shared/setup.ts';
import { testTmdb } from '../integrations/tmdb.ts';
import { asTestResult, HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import { hasArrServer } from '../services/arr-servers.ts';
import { hasMembers } from '../services/media-server.ts';
import {
  getMediaServer,
  getSetting,
  maskSetting,
  savedKeys,
  setSetting,
  withStoredSecrets,
} from '../services/settings.ts';
import { hasOwner } from '../services/users.ts';

type Testers = { [K in IntegrationKey]: (connection: Connection<K>) => Promise<TestResults[K]> };

const isIntegration = (key: SettingKey): key is IntegrationKey => key in connectionSchemas;

/** Paramètre `:service` validé ; inconnu → 404. */
function serviceParam<T extends string>(req: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse((req.params as { service?: unknown }).service);
  if (!parsed.success) throw new HttpError(404, 'Introuvable');
  return parsed.data;
}

export function setupRoutes(app: FastifyInstance) {
  const { db, cryptoKey } = app.data;

  const testers: Testers = {
    mediaServer: async (connection) => {
      const server = app.mediaServers.of({ ...connection, libraryIds: [], publicUrl: null });
      const [info, libraries] = await Promise.all([server.test(), server.listLibraries()]);
      return { ...info, libraries };
    },
    tmdb: testTmdb,
  };
  const runTest = <K extends IntegrationKey>(key: K, connection: Connection<K>): Promise<TestResults[K]> =>
    asTestResult(() => testers[key](connection));

  /**
   * Réglage enregistré d'une section ; le serveur multimédia relit l'ancien réglage `emby` (`getMediaServer`). Sert
   * aussi à reprendre un secret laissé vide : jamais celui d'un autre type de serveur multimédia.
   */
  const storedOf = (key: SettingSection, input?: unknown) => {
    if (key !== 'mediaServer') return getSetting(db, cryptoKey, key);
    const stored = getMediaServer(db, cryptoKey);
    const kind = (input as { kind?: unknown } | null | undefined)?.kind;
    return input === undefined || stored?.kind === kind ? stored : null;
  };

  /**
   * Un seul serveur multimédia, choisi à l'installation : les comptes des membres portent les ids de ses utilisateurs,
   * et leurs demandes en dépendent. Passer à un autre type une fois des membres créés casserait tout (DECISIONS.md).
   */
  function refuseKindChange(next: Setting<'mediaServer'>) {
    const stored = getMediaServer(db, cryptoKey);
    if (stored && stored.kind !== next.kind && hasMembers(app.data))
      throw new HttpError(
        409,
        `Impossible de passer ${ofMediaServer(stored.kind)} à ${mediaServerKindLabels[next.kind]} : des membres existent déjà et leurs comptes (avec leurs demandes) sont liés à ${mediaServerKindLabels[stored.kind]}.`,
      );
  }

  app.get(SETUP_STATE_PATH, async (): Promise<SetupState> => {
    const saved = savedKeys(db);
    for (const kind of arrKinds) if (hasArrServer(db, kind)) saved.add(kind);
    const mediaServerKind = getMediaServer(db, cryptoKey)?.kind ?? null;
    if (mediaServerKind) saved.add('mediaServer');
    const services = Object.fromEntries(setupSections.map((s) => [s, saved.has(s)])) as Record<SetupSection, boolean>;
    const owner = hasOwner(db);
    return { services, mediaServerKind, hasOwner: owner, complete: owner && setupSections.every((s) => services[s]) };
  });

  app.post(setupTestPath(':service'), ownerOnly, async (req) => {
    const key = serviceParam(req, integrationKeySchema);
    const input = withStoredSecrets(key, req.body, storedOf(key, req.body));
    return runTest(key, parseRequest(connectionSchemas[key] as z.ZodType<Connection<typeof key>>, input));
  });

  app.get(settingPath(':service'), ownerOnly, async (req): Promise<MaskedSetting<SettingSection>> => {
    const key = serviceParam(req, settingSectionSchema);
    // Les règles ont des valeurs par défaut ; une intégration jamais enregistrée n'a rien à montrer.
    const value = storedOf(key) ?? (key === 'rules' ? settingSchemas.rules.parse({}) : null);
    if (!value) throw new HttpError(404, 'Pas encore configuré');
    return maskSetting(key, value);
  });

  app.put(settingPath(':service'), ownerOnly, async (req): Promise<MaskedSetting<SettingSection>> => {
    const key = serviceParam(req, settingSectionSchema);
    const input = withStoredSecrets(key, req.body, storedOf(key, req.body));
    const value = parseRequest(settingSchemas[key] as z.ZodType<Setting<typeof key>>, input);
    if (key === 'mediaServer') refuseKindChange(value as Setting<'mediaServer'>);
    if (isIntegration(key)) await runTest(key, connectionSchemas[key].parse(value) as Connection<typeof key>);
    return maskSetting(key, setSetting(db, cryptoKey, key, value));
  });
}
