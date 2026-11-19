import type { FastifyInstance } from 'fastify';
import {
  approveRequestSchema,
  type BatchResult,
  batchRequestSchema,
  createRequestSchema,
  declineRequestSchema,
  quotaQuerySchema,
  REQUEST_BATCH_PATH,
  REQUEST_COUNTS_PATH,
  REQUEST_QUOTA_PATH,
  REQUESTS_PATH,
  type RequestCounts,
  type RequestDetail,
  type RequestPage,
  type RequestQuota,
  requestIdParamsSchema,
  requestListQuerySchema,
  requestPath,
  type SendOptions,
  sendOptionsParamsSchema,
  sendOptionsPath,
  sendOptionsQuerySchema,
  updateRequestSchema,
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
  // Listes d'envoi : approbateurs, et membres qui choisissent eux-mêmes (« Demande avancée »).
  const canChooseSend = { preHandler: requireCapability('canManageRequests', 'canAdvancedRequest') };
  const idOf = (params: unknown) => parseRequest(requestIdParamsSchema, params).id;

  app.post(REQUESTS_PATH, canRequest, async (req, reply): Promise<RequestDetail> => {
    const input = parseRequest(createRequestSchema, req.body);
    const { request, created } = await service.create(viewerOf(req), input);
    // Double clic : la demande déjà en cours est renvoyée en 200, rien n'est créé.
    reply.code(created ? 201 : 200);
    return request;
  });

  app.get(
    REQUESTS_PATH,
    canRequest,
    async (req): Promise<RequestPage> => service.list(viewerOf(req), parseRequest(requestListQuerySchema, req.query)),
  );

  // `?userId=` : quota d'un autre membre (feuille de demande pour autrui), droit « Demander pour un autre » sinon 403.
  app.get(
    REQUEST_QUOTA_PATH,
    canRequest,
    async (req): Promise<RequestQuota> =>
      service.quota(viewerOf(req), parseRequest(quotaQuerySchema, req.query).userId),
  );

  app.get(REQUEST_COUNTS_PATH, canRequest, async (req): Promise<RequestCounts> => service.counts(viewerOf(req)));

  // Listes de l'approbation et de la demande avancée (serveurs, profils, dossiers) : ni adresse ni clé ; aucun
  // serveur → 503.
  app.get(
    sendOptionsPath(':type'),
    canChooseSend,
    async (req): Promise<SendOptions> =>
      sendOptions(
        app.data,
        app.tmdb,
        parseRequest(sendOptionsParamsSchema, req.params).type,
        parseRequest(sendOptionsQuerySchema, req.query),
      ),
  );

  app.get(
    requestPath(':id'),
    canRequest,
    async (req): Promise<RequestDetail> => service.get(viewerOf(req), idOf(req.params)),
  );

  // Modification d'une demande en attente : le demandeur, ou un gestionnaire (contrôlé par le service).
  app.patch(
    requestPath(':id'),
    canRequest,
    async (req): Promise<RequestDetail> =>
      service.update(viewerOf(req), idOf(req.params), parseRequest(updateRequestSchema, req.body ?? {})),
  );

  app.post(
    requestPath(':id', 'approve'),
    canManage,
    async (req): Promise<RequestDetail> =>
      service.approve(idOf(req.params), viewerOf(req).user, parseRequest(approveRequestSchema, req.body ?? {})),
  );

  app.post(requestPath(':id', 'decline'), canManage, async (req): Promise<RequestDetail> => {
    const { reason } = parseRequest(declineRequestSchema, req.body);
    return service.decline(idOf(req.params), viewerOf(req).user, reason);
  });

  app.post(
    requestPath(':id', 'retry'),
    canManage,
    async (req): Promise<RequestDetail> => service.retry(idOf(req.params), viewerOf(req).user),
  );

  app.post(
    requestPath(':id', 'cancel'),
    canRequest,
    async (req): Promise<RequestDetail> => service.cancel(idOf(req.params), viewerOf(req)),
  );

  app.post(
    REQUEST_BATCH_PATH,
    canManage,
    async (req): Promise<BatchResult> => service.batch(viewerOf(req).user, parseRequest(batchRequestSchema, req.body)),
  );
}
