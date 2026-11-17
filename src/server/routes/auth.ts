import type { FastifyInstance } from 'fastify';
import { loginSchema } from '../../shared/auth.ts';
import { authenticateEmbyUser } from '../integrations/emby.ts';
import { IntegrationError } from '../integrations/http.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { createRateLimiter } from '../lib/rate-limit.ts';
import { endSession, refreshSessionCookie, startSession, viewerOf } from '../plugins/auth.ts';
import { requireEmby } from '../services/settings.ts';
import { toViewer, upsertFromEmby } from '../services/users.ts';

export const LOGIN_LIMIT = { limit: 10, windowMs: 5 * 60_000 };

export function authRoutes(app: FastifyInstance) {
  // Par instance : chaque application (et chaque test) a son propre compteur.
  const loginLimiter = createRateLimiter(LOGIN_LIMIT);

  app.post('/api/auth/login', async (req, reply) => {
    const blocked = loginLimiter.hit(req.ip);
    if (blocked) {
      reply.header('retry-after', Math.ceil(blocked.retryAfterMs / 1000));
      throw new HttpError(429, 'Trop de tentatives de connexion, réessayez dans quelques minutes');
    }
    const { username, password } = parseRequest(loginSchema, req.body);
    const emby = requireEmby(app.data);
    const embyUser = await authenticateEmbyUser(emby, username, password).catch((error: unknown) => {
      if (error instanceof IntegrationError && error.kind === 'unauthorized') throw new HttpError(401, error.message);
      throw error;
    });
    const user = upsertFromEmby(app.data.db, {
      id: embyUser.id,
      name: embyUser.name,
      avatar: embyUser.avatarUrl,
      isEmbyAdmin: embyUser.isAdmin,
    });
    startSession(req, reply, user.id);
    return { viewer: toViewer(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    endSession(req, reply);
    return reply.code(204).send();
  });

  // Appelée par le client au chargement : prolonge aussi le cookie.
  app.get('/api/auth/me', async (req, reply) => {
    const { user } = viewerOf(req);
    refreshSessionCookie(req, reply);
    return { viewer: toViewer(user) };
  });
}
