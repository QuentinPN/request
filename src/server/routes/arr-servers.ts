import type { FastifyInstance } from 'fastify';
import {
  ARR_SERVERS_PATH,
  ARR_SERVERS_TEST_PATH,
  type ArrKind,
  type ArrServer,
  arrServerIdParamsSchema,
  arrServerInputSchema,
  arrServerTestSchema,
} from '../../shared/arr-servers.ts';
import type { ArrTestResult } from '../../shared/setup.ts';
import type { ArrConfig } from '../integrations/arr.ts';
import { testRadarr } from '../integrations/radarr.ts';
import { testSonarr } from '../integrations/sonarr.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { requireCapability } from '../plugins/auth.ts';
import {
  deleteArrServer,
  getArrServer,
  listArrServers,
  maskArrServer,
  saveArrServer,
} from '../services/arr-servers.ts';
import { withStoredFields } from '../services/settings.ts';
import { asTestResult } from './setup.ts';

const testers: Record<ArrKind, (config: ArrConfig) => Promise<ArrTestResult>> = {
  radarr: testRadarr,
  sonarr: testSonarr,
};

/**
 * Serveurs Radarr et Sonarr (propriétaire seulement) : liste, test en direct, ajout, modification, suppression. Une clé
 * laissée vide garde celle du serveur enregistré, à la même adresse seulement (`withStoredFields`). Ajout et
 * modification refont le test de connexion : un serveur injoignable n'est jamais enregistré.
 */
export function arrServersRoutes(app: FastifyInstance) {
  const ownerOnly = { preHandler: requireCapability('isOwner') };
  const idOf = (params: unknown) => parseRequest(arrServerIdParamsSchema, params).id;
  const stored = (id: number | undefined) => {
    if (id === undefined) return null;
    const server = getArrServer(app.data, id);
    if (!server) throw new HttpError(404, 'Serveur introuvable');
    return server;
  };
  const test = (kind: ArrKind, config: ArrConfig) => asTestResult(() => testers[kind](config));

  app.get(ARR_SERVERS_PATH, ownerOnly, async (): Promise<ArrServer[]> => listArrServers(app.data).map(maskArrServer));

  app.post(ARR_SERVERS_TEST_PATH, ownerOnly, async (req): Promise<ArrTestResult> => {
    const id = (req.body as { id?: unknown } | null)?.id;
    const input = withStoredFields(['apiKey'], req.body, typeof id === 'number' ? stored(id) : null);
    const { type, url, apiKey } = parseRequest(arrServerTestSchema, input);
    return test(type, { url, apiKey });
  });

  const save = async (body: unknown, id?: number): Promise<ArrServer> => {
    const values = parseRequest(arrServerInputSchema, withStoredFields(['apiKey'], body, stored(id)));
    await test(values.type, values);
    return maskArrServer(saveArrServer(app.data, values, id));
  };

  app.post(ARR_SERVERS_PATH, ownerOnly, async (req, reply) => {
    const server = await save(req.body);
    reply.code(201);
    return server;
  });

  app.put(`${ARR_SERVERS_PATH}/:id`, ownerOnly, async (req) => save(req.body, idOf(req.params)));

  app.delete(`${ARR_SERVERS_PATH}/:id`, ownerOnly, async (req, reply) => {
    deleteArrServer(app.data.db, idOf(req.params));
    reply.code(204);
  });
}
