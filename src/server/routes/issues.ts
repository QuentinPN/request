import type { FastifyInstance } from 'fastify';
import {
  type IssueCounts,
  type IssueDetail,
  type IssuePage,
  issueCommentInputSchema,
  issueCreateSchema,
  issueIdParamsSchema,
  issueListQuerySchema,
} from '../../shared/issues.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import { createIssues } from '../services/issues.ts';

/**
 * Signalements de problèmes (session et CSRF par le garde global de `/api`) : tout membre signale, suit et commente
 * les siens ; le droit « gérer les signalements » voit, commente, résout et rouvre tous les autres. Un signalement
 * qu'on ne peut pas voir est introuvable (404).
 */
export function issuesRoutes(app: FastifyInstance) {
  const service = createIssues(app.data, { tmdb: app.tmdb, availability: app.availability });
  const idOf = (params: unknown) => parseRequest(issueIdParamsSchema, params).id;

  app.post('/api/issues', async (req, reply): Promise<IssueDetail> => {
    const issue = await service.create(viewerOf(req), parseRequest(issueCreateSchema, req.body));
    reply.code(201);
    return issue;
  });

  app.get(
    '/api/issues',
    async (req): Promise<IssuePage> => service.list(viewerOf(req), parseRequest(issueListQuerySchema, req.query)),
  );

  app.get('/api/issues/counts', async (req): Promise<IssueCounts> => service.counts(viewerOf(req)));

  app.get('/api/issues/:id', async (req): Promise<IssueDetail> => service.get(viewerOf(req), idOf(req.params)));

  app.post(
    '/api/issues/:id/comments',
    async (req): Promise<IssueDetail> =>
      service.comment(viewerOf(req), idOf(req.params), parseRequest(issueCommentInputSchema, req.body)),
  );

  app.post(
    '/api/issues/:id/resolve',
    async (req): Promise<IssueDetail> => service.resolve(viewerOf(req), idOf(req.params)),
  );

  app.post(
    '/api/issues/:id/reopen',
    async (req): Promise<IssueDetail> => service.reopen(viewerOf(req), idOf(req.params)),
  );
}
