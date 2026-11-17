import { createHmac } from 'node:crypto';
import fastifyCookie, { type CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, CSRF_VALUE } from '../../shared/auth.ts';
import { type Capabilities, capabilitiesOf } from '../../shared/roles.ts';
import { HttpError } from '../lib/api-errors.ts';
import { createSession, revokeSession, SESSION_TTL_MS, validateSession } from '../services/sessions.ts';
import { hasOwner, type User } from '../services/users.ts';

export interface SessionViewer {
  user: User;
  capabilities: Capabilities;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Membre de la session, `null` sans cookie valide. Renseigné pour toute route `/api`. */
    viewer: SessionViewer | null;
  }
}

export const SESSION_COOKIE = 'request_session';

const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  // HTTPS derrière Caddy : `X-Forwarded-Proto` n'est lu que d'un proxy de confiance (`TRUST_PROXY`, voir app.ts).
  secure: 'auto',
  signed: true,
} as const satisfies CookieSerializeOptions;

// --- Règles d'accès : le seul endroit où elles sont écrites ---

/**
 * Routes ouvertes sans session (`MÉTHODE /motif`, HEAD compté comme GET). La déconnexion en fait partie : elle
 * efface toujours le cookie, même si la session est déjà invalide.
 */
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/setup/state',
]);
/** Webhooks entrants : authentifiés par leur propre jeton, sans session ni en-tête CSRF. */
const WEBHOOKS_PREFIX = '/api/webhooks/';
/** Amorçage (PRODUCT §1) : tant qu'aucun propriétaire n'existe, tester et enregistrer Emby est ouvert à tous. */
const BOOTSTRAP_ROUTES = new Set(['POST /api/setup/:service/test', 'PUT /api/settings/:service']);

const routeKey = (req: FastifyRequest) => `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url ?? ''}`;

function isBootstrap(req: FastifyRequest): boolean {
  return (
    BOOTSTRAP_ROUTES.has(routeKey(req)) &&
    (req.params as { service?: string }).service === 'emby' &&
    !hasOwner(req.server.data.db)
  );
}

const isPublic = (req: FastifyRequest) => PUBLIC_ROUTES.has(routeKey(req)) || isBootstrap(req);

/** Écriture : en-tête maison exigé, et origine absente ou identique à l'hôte appelé. */
function passesCsrf(req: FastifyRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const from = new URL(origin);
    // Même schéma des deux côtés pour que le port par défaut (`:80`, `:443`) soit ignoré pareil.
    return from.host === new URL(`${from.protocol}//${req.host}`).host;
  } catch {
    return false;
  }
}

// --- Session ---

function sessionToken(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const { valid, value } = req.unsignCookie(raw);
  return valid && value ? value : null;
}

function readViewer(req: FastifyRequest): SessionViewer | null {
  const token = sessionToken(req);
  const user = token ? validateSession(req.server.data.db, token) : null;
  return user ? { user, capabilities: capabilitiesOf(user.role) } : null;
}

/** Ouvre une session pour ce membre et pose le cookie. */
export function startSession(req: FastifyRequest, reply: FastifyReply, userId: string): void {
  const { token, expiresAt } = createSession(req.server.data.db, userId, req.headers['user-agent'] ?? null);
  reply.setCookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, expires: expiresAt });
}

/**
 * Repousse l'expiration du cookie comme celle de la session en base (expiration glissante) : sans cela,
 * le navigateur jetterait le cookie 30 jours après la connexion, même pour un membre actif.
 */
export function refreshSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const token = sessionToken(req);
  if (token)
    reply.setCookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, expires: new Date(Date.now() + SESSION_TTL_MS) });
}

/** Révoque la session courante (si elle existe) et efface le cookie. */
export function endSession(req: FastifyRequest, reply: FastifyReply): void {
  const token = sessionToken(req);
  if (token) revokeSession(req.server.data.db, token);
  reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

/** Membre connecté d'une route protégée (le garde global a déjà renvoyé 401 sinon). */
export function viewerOf(req: FastifyRequest): SessionViewer {
  if (!req.viewer) throw new HttpError(401, 'Connexion requise');
  return req.viewer;
}

/** preHandler : 403 si le membre n'a pas ce droit (sauf route d'amorçage encore ouverte). */
export const requireCapability = (capability: keyof Capabilities) => async (req: FastifyRequest) => {
  if (isBootstrap(req)) return;
  if (!req.viewer?.capabilities[capability]) throw new HttpError(403, 'Accès refusé');
};

/**
 * Cookies signés, membre de la session sur `req.viewer`, et garde global de `/api` : toute route est protégée
 * par défaut (401), les exceptions sont listées ci-dessus. Les écritures passent le contrôle CSRF (403).
 * Une adresse sans route garde son 404.
 */
export async function registerAuth(app: FastifyInstance) {
  // Clé de signature dérivée de la clé de chiffrement : rien de plus à stocker.
  const secret = createHmac('sha256', app.data.cryptoKey).update('request:cookie').digest();
  await app.register(fastifyCookie, { secret });
  app.decorateRequest('viewer', null);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url?.startsWith('/api/') || url.startsWith(WEBHOOKS_PREFIX)) return;
    if (!passesCsrf(req)) return reply.code(403).send({ error: 'Requête refusée' });
    req.viewer = readViewer(req);
    if (!req.viewer && !isPublic(req)) return reply.code(401).send({ error: 'Connexion requise' });
  });
}
