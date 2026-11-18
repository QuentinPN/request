import type { FastifyInstance } from 'fastify';
import {
  approveRequestSchema,
  type BatchResult,
  batchRequestSchema,
  createRequestSchema,
  declineRequestSchema,
  quotaQuerySchema,
  type RequestCounts,
  type RequestDetail,
  type RequestPage,
  type RequestQuota,
  requestIdParamsSchema,
  requestListQuerySchema,
  type SendOptions,
  sendOptionsParamsSchema,
  sendOptionsQuerySchema,
} from '../../shared/requests.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { requireCapability, viewerOf } from '../plugins/auth.ts';
import { createRequests } from '../services/requests.ts';
import { sendOptions } from '../services/send-options.ts';

/**
 * Demandes : création et suivi (tout membre ayant le droit de demander), approbation, refus, relance et lots
 * (droit de gérer les demandes). Un membre ne voit que ses demandes ; le statut affiché sur les affiches, lui,
 * tient compte des demandes de tous.
 */
export function requestsRoutes(app: FastifyInstance) {
  const service = createRequests(app.data, { tmdb: app.tmdb, availability: app.availability });
  const canRequest = { preHandler: requireCapability('canRequest') };
  const canManage = { preHandler: requireCapability('canManageRequests') };
  const idOf = (params: unknown) => parseRequest(requestIdParamsSchema, params).id;

  app.post('/api/requests', canRequest, async (req, reply): Promise<RequestDetail> => {
    const input = parseRequest(createRequestSchema, req.body);
    const { request, created } = await service.create(viewerOf(req), input);
    // Double clic : la demande déjà en cours est renvoyée en 200, rien n'est créé.
    reply.code(created ? 201 : 200);
    return request;
  });

  app.get(
    '/api/requests',
    canRequest,
    async (req): Promise<RequestPage> => service.list(viewerOf(req), parseRequest(requestListQuerySchema, req.query)),
  );

  // `?userId=` : quota d'un autre membre (feuille de demande pour autrui), droit « Demander pour un autre » sinon 403.
  app.get(
    '/api/requests/quota',
    canRequest,
    async (req): Promise<RequestQuota> =>
      service.quota(viewerOf(req), parseRequest(quotaQuerySchema, req.query).userId),
  );

  app.get('/api/requests/counts', canRequest, async (req): Promise<RequestCounts> => service.counts(viewerOf(req)));

  // Listes de l'approbation (serveurs, profils, dossiers) : ni adresse ni clé ; aucun serveur → 503.
  app.get(
    '/api/requests/send-options/:type',
    canManage,
    async (req): Promise<SendOptions> =>
      sendOptions(
        app.data,
        parseRequest(sendOptionsParamsSchema, req.params).type,
        parseRequest(sendOptionsQuerySchema, req.query),
      ),
  );

  app.get(
    '/api/requests/:id',
    canRequest,
    async (req): Promise<RequestDetail> => service.get(viewerOf(req), idOf(req.params)),
  );

  app.post(
    '/api/requests/:id/approve',
    canManage,
    async (req): Promise<RequestDetail> =>
      service.approve(idOf(req.params), viewerOf(req).user, parseRequest(approveRequestSchema, req.body ?? {})),
  );

  app.post('/api/requests/:id/decline', canManage, async (req): Promise<RequestDetail> => {
    const { reason } = parseRequest(declineRequestSchema, req.body);
    return service.decline(idOf(req.params), viewerOf(req).user, reason);
  });

  app.post(
    '/api/requests/:id/retry',
    canManage,
    async (req): Promise<RequestDetail> => service.retry(idOf(req.params), viewerOf(req).user),
  );

  app.post(
    '/api/requests/:id/cancel',
    canRequest,
    async (req): Promise<RequestDetail> => service.cancel(idOf(req.params), viewerOf(req)),
  );

  app.post(
    '/api/requests/batch',
    canManage,
    async (req): Promise<BatchResult> => service.batch(viewerOf(req).user, parseRequest(batchRequestSchema, req.body)),
  );
}
