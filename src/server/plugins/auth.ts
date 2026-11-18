import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyCookie, { type CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_HEADER } from '../../shared/api-keys.ts';
import { CSRF_HEADER, CSRF_VALUE, LOGIN_PATH, LOGOUT_PATH } from '../../shared/auth.ts';
import { HEALTH_PATH } from '../../shared/health.ts';
import { PLEX_PIN_CHECK_PATH, PLEX_PIN_PATH } from '../../shared/media-server.ts';
import { type Capabilities, capabilitiesOf } from '../../shared/roles.ts';
import { SETUP_STATE_PATH, SETUP_TOKEN_HEADER, settingPath, setupTestPath } from '../../shared/setup.ts';
import { webhookPath, webhookServices } from '../../shared/webhooks.ts';
import { HttpError } from '../lib/api-errors.ts';
import { createRateLimiter, setRetryAfter } from '../lib/rate-limit.ts';
import { authenticateApiKey } from '../services/api-keys.ts';
import { createSession, revokeSession, SESSION_TTL_MS, validateSession } from '../services/sessions.ts';
import { hasOwner, type User } from '../services/users.ts';

export interface SessionViewer {
  user: User;
  capabilities: Capabilities;
  /** Comment la requête s'est authentifiée : cookie de session, ou clé d'API (`X-Api-Key`). */
  via: 'session' | 'apiKey';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Membre de la session, `null` sans cookie valide. Renseigné pour toute route `/api`. */
    viewer: SessionViewer | null;
  }
  interface FastifyInstance {
    /** Jeton d'installation (`parseSetupToken`) : jamais envoyé au client, seulement écrit dans les journaux. */
    setupToken: string;
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
  `GET ${HEALTH_PATH}`,
  `POST ${LOGIN_PATH}`,
  `POST ${PLEX_PIN_PATH}`,
  `POST ${PLEX_PIN_CHECK_PATH}`,
  `POST ${LOGOUT_PATH}`,
  `GET ${SETUP_STATE_PATH}`,
]);
/**
 * Webhooks entrants Radarr/Sonarr, ces deux routes exactement : authentifiés par leur propre jeton (routes/webhooks.ts),
 * sans session ni en-tête CSRF (Radarr et Sonarr ne peuvent envoyer ni l'un ni l'autre).
 */
const WEBHOOK_ROUTES = new Set(webhookServices.map((service) => `POST ${webhookPath(service)}`));
/**
 * Amorçage (PRODUCT §1) : tant qu'aucun propriétaire n'existe, tester et enregistrer le serveur multimédia est ouvert
 * sans session à qui présente le jeton d'installation (`X-Setup-Token`), écrit dans les journaux du serveur.
 */
const BOOTSTRAP_ROUTES = new Set([`POST ${setupTestPath(':service')}`, `PUT ${settingPath(':service')}`]);

const routeKey = (req: FastifyRequest) => `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url ?? ''}`;

/** Route d'amorçage encore ouverte (aucun propriétaire), jeton présenté ou non. */
const isBootstrapRoute = (req: FastifyRequest) =>
  BOOTSTRAP_ROUTES.has(routeKey(req)) &&
  (req.params as { service?: string }).service === 'mediaServer' &&
  !hasOwner(req.server.data.db);

/** Jeton d'installation : `SETUP_TOKEN` s'il est renseigné (non vide), sinon tiré au hasard à chaque démarrage. */
export const parseSetupToken = (env: string | undefined) => env?.trim() || randomBytes(24).toString('base64url');

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Jeton d'installation présenté, comparé à temps constant (empreintes de même longueur, quelle que soit la saisie). */
function hasSetupToken(req: FastifyRequest): boolean {
  const sent = req.headers[SETUP_TOKEN_HEADER];
  return typeof sent === 'string' && timingSafeEqual(digest(sent), digest(req.server.setupToken));
}

const isBootstrap = (req: FastifyRequest) => isBootstrapRoute(req) && hasSetupToken(req);

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
  return user ? { user, capabilities: capabilitiesOf(user.role), via: 'session' } : null;
}

// --- Clé d'API ---

/** Essais de clé d'API invalide par adresse IP ; au-delà, toute clé invalide de cette adresse reçoit 429. */
export const API_KEY_LIMIT = { limit: 10, windowMs: 5 * 60_000 };
/** Essais de jeton d'installation invalide par adresse IP : mêmes bornes. */
export const SETUP_TOKEN_LIMIT = API_KEY_LIMIT;

type RateLimiter = ReturnType<typeof createRateLimiter>;

/** Essai refusé, compté pour l'IP : `refusal`, ou 429 (avec `Retry-After`) si la limite était déjà atteinte. */
function refuseCounted(
  req: FastifyRequest,
  reply: FastifyReply,
  limiter: RateLimiter,
  refusal: { code: number; error: string },
  tooMany: string,
): FastifyReply {
  const blocked = limiter.peek(req.ip);
  limiter.hit(req.ip);
  if (blocked) {
    setRetryAfter(reply, blocked);
    return reply.code(429).send({ error: tooMany });
  }
  return reply.code(refusal.code).send({ error: refusal.error });
}

/**
 * Requête à clé d'API : la clé est le seul justificatif, jamais combiné à un cookie de session (refus 400, sans
 * repli de l'un sur l'autre). Pas de cookie, donc pas de CSRF ni d'origine à contrôler. Clé inconnue, révoquée ou
 * dont le créateur n'est plus propriétaire : essai compté pour l'IP, 401, ou 429 si la limite est atteinte. Une clé
 * valide passe toujours, sans consulter la limite. S'applique à toute route `/api`, publiques comprises.
 */
function authenticateWithApiKey(
  req: FastifyRequest,
  reply: FastifyReply,
  limiter: RateLimiter,
): FastifyReply | undefined {
  if (req.cookies[SESSION_COOKIE] !== undefined)
    return reply
      .code(400)
      .send({ error: 'Cookie de session et clé d’API ne se combinent pas : n’envoyez que l’un des deux' });
  const secret = req.headers[API_KEY_HEADER];
  const user = typeof secret === 'string' ? authenticateApiKey(req.server.data.db, secret) : null;
  if (user) {
    req.viewer = { user, capabilities: capabilitiesOf(user.role), via: 'apiKey' };
    return undefined;
  }
  return refuseCounted(
    req,
    reply,
    limiter,
    { code: 401, error: 'Clé d’API invalide' },
    'Trop de clés d’API invalides, réessayez dans quelques minutes',
  );
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

/** preHandler : 403 si le membre n'a pas ce droit (sauf route d'amorçage encore ouverte, avec le jeton d'installation). */
export const requireCapability = (capability: keyof Capabilities) => async (req: FastifyRequest) => {
  if (isBootstrap(req)) return;
  if (!req.viewer?.capabilities[capability]) throw new HttpError(403, 'Accès refusé');
};

/** Options d'une route réservée au propriétaire (le serveur multimédia reste ouvert pendant l'amorçage, `isBootstrap`). */
export const ownerOnly = { preHandler: requireCapability('isOwner') };

/** preHandler : 403 si la requête s'est authentifiée par clé d'API (réservé à la session : une clé ne crée pas de clé). */
export const forbidApiKey = async (req: FastifyRequest) => {
  if (req.viewer?.via === 'apiKey') throw new HttpError(403, 'Cette route n’accepte pas les clés d’API');
};

/**
 * Cookies signés, membre de la session (ou de la clé d'API) sur `req.viewer`, et garde global de `/api` : toute
 * route est protégée par défaut (401), les exceptions sont listées ci-dessus. Les écritures de session passent le
 * contrôle CSRF (403).
 * Une adresse sans route garde son 404.
 */
export async function registerAuth(app: FastifyInstance, { setupToken }: { setupToken: string }) {
  // Clé de signature dérivée de la clé de chiffrement : rien de plus à stocker.
  const secret = createHmac('sha256', app.data.cryptoKey).update('request:cookie').digest();
  await app.register(fastifyCookie, { secret });
  app.decorateRequest('viewer', null);
  app.decorate('setupToken', setupToken);

  // Par instance : chaque application (et chaque test) a ses propres compteurs.
  const apiKeyLimiter = createRateLimiter(API_KEY_LIMIT);
  const setupTokenLimiter = createRateLimiter(SETUP_TOKEN_LIMIT);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url?.startsWith('/api/') || WEBHOOK_ROUTES.has(routeKey(req))) return;
    // Avant le CSRF : une requête à clé n'a pas de cookie à protéger.
    if (req.headers[API_KEY_HEADER] !== undefined) return authenticateWithApiKey(req, reply, apiKeyLimiter);
    if (!passesCsrf(req)) return reply.code(403).send({ error: 'Requête refusée' });
    req.viewer = readViewer(req);
    if (req.viewer) return;
    // Limite atteinte : même le bon jeton est refusé (429), sinon la limite ne freinerait pas un devinage.
    if (isBootstrapRoute(req))
      return hasSetupToken(req) && !setupTokenLimiter.peek(req.ip)
        ? undefined
        : refuseCounted(
            req,
            reply,
            setupTokenLimiter,
            { code: 403, error: SETUP_TOKEN_REFUSED },
            'Trop de jetons d’installation invalides, réessayez dans quelques minutes',
          );
    if (isPublic(req)) return;
    return reply.code(401).send({ error: 'Connexion requise' });
  });
}

const SETUP_TOKEN_REFUSED =
  'Jeton d’installation manquant ou invalide. Il est écrit dans les journaux du serveur à son démarrage (docker compose logs request), ou fixé par la variable SETUP_TOKEN.';

/** Démarrage sans propriétaire : le jeton d'installation, sur une ligne des journaux (serveur et `npm run dev`), sauf s'il vient de `SETUP_TOKEN` (déjà connu de l'administrateur, à ne pas copier dans les journaux). */
export function announceSetupToken(app: FastifyInstance): void {
  if (hasOwner(app.data.db)) return;
  const shown = process.env.SETUP_TOKEN?.trim() ? 'celui de la variable SETUP_TOKEN.' : app.setupToken;
  console.log(`Jeton d’installation : ${shown}`);
}
