import type { FastifyInstance } from 'fastify';
import {
  API_KEYS_PATH,
  type ApiKey,
  type ApiKeyCreated,
  apiKeyCreateSchema,
  apiKeyIdParamsSchema,
  apiKeyPath,
} from '../../shared/api-keys.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { forbidApiKey, requireCapability, viewerOf } from '../plugins/auth.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-keys.ts';

/**
 * Clés d'API publiques (propriétaire seulement, par session : une clé ne crée, ne liste ni ne révoque de clé).
 * Seul le hash est gardé ; le secret n'est renvoyé que par la création.
 */
export function apiKeysRoutes(app: FastifyInstance) {
  const { db } = app.data;
  const sessionOwner = { preHandler: [forbidApiKey, requireCapability('isOwner')] };

  app.get(API_KEYS_PATH, sessionOwner, async (): Promise<ApiKey[]> => listApiKeys(db));

  app.post(API_KEYS_PATH, sessionOwner, async (req, reply): Promise<ApiKeyCreated> => {
    const { name } = parseRequest(apiKeyCreateSchema, req.body);
    reply.code(201);
    return createApiKey(db, viewerOf(req).user, name);
  });

  app.delete(apiKeyPath(':id'), sessionOwner, async (req, reply) => {
    revokeApiKey(db, parseRequest(apiKeyIdParamsSchema, req.params).id);
    return reply.code(204).send();
  });
}
