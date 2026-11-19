import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyCookie, { type CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_HEADER, type ApiKeyScope } from '../../shared/api-keys.ts';
import { API_VERSION_PATH } from '../../shared/api-version.ts';
import {
  CSRF_HEADER,
  CSRF_VALUE,
  EMBY_TOKEN_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  userPath,
  VIEWER_PATH,
} from '../../shared/auth.ts';
import {
  browsePath,
  collectionPath,
  DISCOVER_PATH,
  discoverListPath,
  genresPath,
  mediaPath,
  personPath,
  providersPath,
  SEARCH_PATH,
} from '../../shared/catalogue.ts';
import { HEALTH_PATH } from '../../shared/health.ts';
import { ISSUE_COUNTS_PATH, ISSUES_PATH, issuePath } from '../../shared/issues.ts';
import { IMAGE_BASE_URL } from '../../shared/media.ts';
import { PLEX_PIN_CHECK_PATH, PLEX_PIN_PATH } from '../../shared/media-server.ts';
import { REQUEST_COUNTS_PATH, REQUEST_QUOTA_PATH, REQUESTS_PATH, requestPath } from '../../shared/requests.ts';
import { type Capabilities, capabilitiesOf } from '../../shared/roles.ts';
import { SETUP_STATE_PATH, SETUP_TOKEN_HEADER, settingPath, setupTestPath } from '../../shared/setup.ts';
import { STATS_PATH } from '../../shared/stats.ts';
import { webhookPath, webhookServices } from '../../shared/webhooks.ts';
import { HttpError } from '../lib/api-errors.ts';
import { createRateLimiter, setRetryAfter } from '../lib/rate-limit.ts';
import { authenticateApiKey } from '../services/api-keys.ts';
import { createSession, revokeSession, SESSION_TTL_MS, validateSession } from '../services/sessions.ts';
import { hasOwner, type User } from '../services/users.ts';

export interface SessionViewer {
  user: User;
  capabilities: Capabilities;
  /**
   * Comment la requête s'est authentifiée : cookie de session, clé d'API (`X-Api-Key`, au plus les droits de son
   * créateur, limités à sa portée), ou jeton de session en `Authorization: Bearer` (client natif : droits réels du
   * membre de la session).
   */
  via: 'session' | 'apiKey' | 'bearer';
  /** Portée de la clé d'API (`via: 'apiKey'`), `null` pour une session ou un Bearer. */
  apiKeyScope: ApiKeyScope | null;
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
export const PUBLIC_ROUTES = new Set([
  `GET ${HEALTH_PATH}`,
  `GET ${API_VERSION_PATH}`,
  `POST ${LOGIN_PATH}`,
  `POST ${PLEX_PIN_PATH}`,
  `POST ${PLEX_PIN_CHECK_PATH}`,
  `POST ${LOGOUT_PATH}`,
  `GET ${SETUP_STATE_PATH}`,
  `POST ${EMBY_TOKEN_PATH}`,
]);
/**
 * Routes publiques des clients natifs (Viewer), sans contrôle CSRF (ni `X-Request` ni origine) : appelées par
 * du code natif, pas par un navigateur. Le garde lit le cookie comme partout (`readViewer`), mais la route ne s'en
 * sert pas et n'en pose aucun (la session revient dans le corps) : un formulaire d'un autre site ne peut rien y faire
 * au nom du visiteur, et ne lirait pas la réponse (CORS).
 */
const NATIVE_ROUTES = new Set([`POST ${EMBY_TOKEN_PATH}`]);
/**
 * Webhooks entrants Radarr/Sonarr, ces deux routes exactement : authentifiés par leur propre jeton (routes/webhooks.ts),
 * sans session ni en-tête CSRF (Radarr et Sonarr ne peuvent envoyer ni l'un ni l'autre).
 */
export const WEBHOOK_ROUTES = new Set(webhookServices.map((service) => `POST ${webhookPath(service)}`));
/**
 * Amorçage (PRODUCT §1) : tant qu'aucun propriétaire n'existe, tester et enregistrer le serveur multimédia est ouvert
 * sans session à qui présente le jeton d'installation (`X-Setup-Token`), écrit dans les journaux du serveur.
 */
const BOOTSTRAP_ROUTES = new Set([`POST ${setupTestPath(':service')}`, `PUT ${settingPath(':service')}`]);

/**
 * Routes d'une clé d'API à portée limitée (`MÉTHODE /motif`, HEAD compté comme GET), refus par défaut : toute route
 * absente de la liste est refusée (403), les routes publiques mises à part. Lecture seule : rien de ce qui expose un
 * réglage ou un secret du serveur, ni les listes d'envoi (serveurs, profils et dossiers Radarr/Sonarr).
 */
const READ_SCOPE_ROUTES = [
  `GET ${VIEWER_PATH}`,
  `GET ${REQUESTS_PATH}`,
  `GET ${REQUEST_COUNTS_PATH}`,
  `GET ${REQUEST_QUOTA_PATH}`,
  `GET ${requestPath(':id')}`,
  `GET ${ISSUES_PATH}`,
  `GET ${ISSUE_COUNTS_PATH}`,
  `GET ${issuePath(':id')}`,
  `GET ${STATS_PATH}`,
  `GET ${SEARCH_PATH}`,
  `GET ${DISCOVER_PATH}`,
  `GET ${browsePath(':type')}`,
  `GET ${discoverListPath(':type', ':id')}`,
  `GET ${genresPath(':type')}`,
  `GET ${providersPath(':type')}`,
  `GET ${mediaPath(':type', ':id')}`,
  `GET ${personPath(':id')}`,
  `GET ${collectionPath(':id')}`,
  `GET ${IMAGE_BASE_URL}/:size/:file`,
  // Avatars des membres : les `avatarUrl` des demandes, des signalements et de `/me` y renvoient.
  `GET ${userPath(':id', 'avatar')}`,
];
export const API_KEY_SCOPE_ROUTES: Record<Exclude<ApiKeyScope, 'full'>, ReadonlySet<string>> = {
  read: new Set(READ_SCOPE_ROUTES),
  requests: new Set([
    ...READ_SCOPE_ROUTES,
    `POST ${REQUESTS_PATH}`,
    `POST ${requestPath(':id', 'approve')}`,
    `POST ${requestPath(':id', 'decline')}`,
  ]),
};

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

export const OUT_OF_SCOPE_ERROR = 'Cette clé d’API n’a pas accès à cette route';

/** Clé d'API à portée limitée sur une route que sa portée n'ouvre pas (les routes publiques restent ouvertes). */
function isOutOfScope(req: FastifyRequest): boolean {
  const scope = req.viewer?.apiKeyScope;
  return !!scope && scope !== 'full' && !isPublic(req) && !API_KEY_SCOPE_ROUTES[scope].has(routeKey(req));
}

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
  return user ? { user, capabilities: capabilitiesOf(user), via: 'session', apiKeyScope: null } : null;
}

// --- Justificatifs en en-tête : clé d'API, jeton de session en Bearer ---

/** Essais de clé d'API invalide par adresse IP ; au-delà, toute clé invalide de cette adresse reçoit 429. */
export const API_KEY_LIMIT = { limit: 10, windowMs: 5 * 60_000 };
/** Essais de jeton d'installation invalide par adresse IP : mêmes bornes. */
export const SETUP_TOKEN_LIMIT = API_KEY_LIMIT;
/** Essais de jeton Bearer invalide par adresse IP : mêmes bornes. */
export const BEARER_LIMIT = API_KEY_LIMIT;

/**
 * `Authorization: Bearer <jeton>` : schéma sans casse (RFC 7235), un seul espace, jeton base64url comme ceux de
 * `createSession`. Tout autre contenu (autre schéma, jeton vide ou malformé) est refusé sans consulter la base. Le jeton
 * n'est lu que dans cet en-tête, jamais dans l'adresse (`?token=`, `?access_token=`) : une adresse finit dans les
 * journaux, l'historique et l'en-tête `Referer`.
 */
const BEARER = /^Bearer ([\w-]+)$/i;
/** Schéma `Bearer` (même mal formé) : les autres schémas (`Basic`…) ne sont pas à nous, on les ignore. */
const BEARER_SCHEME = /^Bearer(\s|$)/i;

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return typeof header === 'string' ? (BEARER.exec(header)?.[1] ?? null) : null;
}

/** Façons de s'authentifier par en-tête, sans cookie. */
type HeaderVia = Exclude<SessionViewer['via'], 'session'>;

const HEADER_CREDENTIALS: Record<
  HeaderVia,
  {
    present: (req: FastifyRequest) => boolean;
    authenticate: (req: FastifyRequest) => { user: User; apiKeyScope: ApiKeyScope | null } | null;
    refused: string;
    tooMany: string;
  }
> = {
  apiKey: {
    present: (req) => req.headers[API_KEY_HEADER] !== undefined,
    authenticate: (req) => {
      const secret = req.headers[API_KEY_HEADER];
      const key = typeof secret === 'string' ? authenticateApiKey(req.server.data.db, secret) : null;
      return key && { user: key.user, apiKeyScope: key.scope };
    },
    refused: 'Clé d’API invalide',
    tooMany: 'Trop de clés d’API invalides, réessayez dans quelques minutes',
  },
  bearer: {
    present: (req) => BEARER_SCHEME.test(req.headers.authorization ?? ''),
    // Même validation que le cookie : session révoquée ou expirée refusée, expiration glissante.
    authenticate: (req) => {
      const token = bearerToken(req);
      const user = token ? validateSession(req.server.data.db, token) : null;
      return user && { user, apiKeyScope: null };
    },
    refused: 'Jeton de session invalide, expiré ou révoqué',
    tooMany: 'Trop de jetons de session invalides, réessayez dans quelques minutes',
  },
};

/** Justificatif en en-tête de la requête (le Bearer d'abord), `null` s'il n'y en a aucun. */
const headerViaOf = (req: FastifyRequest): HeaderVia | null =>
  HEADER_CREDENTIALS.bearer.present(req) ? 'bearer' : HEADER_CREDENTIALS.apiKey.present(req) ? 'apiKey' : null;

/** Nombre de justificatifs présentés (cookie de session, clé d'API, en-tête `Authorization`), valides ou non. */
const credentialCount = (req: FastifyRequest) =>
  [req.cookies[SESSION_COOKIE] !== undefined, ...Object.values(HEADER_CREDENTIALS).map((c) => c.present(req))].filter(
    Boolean,
  ).length;

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
 * Requête à clé d'API ou à jeton Bearer : ce justificatif est le seul, jamais combiné à un autre (cookie de session,
 * clé, Bearer : refus 400, sans repli de l'un sur l'autre). Pas de cookie, donc pas de CSRF ni d'origine à contrôler.
 * Justificatif inconnu, malformé, révoqué ou expiré (clé dont le créateur n'est plus propriétaire comprise) : essai
 * compté pour l'IP, avec un compteur par sorte de justificatif, 401, ou 429 si la limite est atteinte. Un justificatif
 * valide passe toujours, sans consulter la limite. S'applique à toute route `/api`, publiques comprises.
 */
function authenticateWithHeader(
  req: FastifyRequest,
  reply: FastifyReply,
  via: HeaderVia,
  limiter: RateLimiter,
): FastifyReply | undefined {
  if (credentialCount(req) > 1)
    return reply.code(400).send({
      error: 'Cookie de session, clé d’API et jeton Bearer ne se combinent pas : n’envoyez qu’un seul des trois',
    });
  const credential = HEADER_CREDENTIALS[via];
  const found = credential.authenticate(req);
  if (found) {
    req.viewer = { user: found.user, capabilities: capabilitiesOf(found.user), via, apiKeyScope: found.apiKeyScope };
    return undefined;
  }
  return refuseCounted(req, reply, limiter, { code: 401, error: credential.refused }, credential.tooMany);
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

/** Jeton de la session de cette requête (cookie ou Bearer), `null` pour une clé d'API ou sans session. */
export function currentSessionToken(req: FastifyRequest): string | null {
  if (req.viewer?.via === 'bearer') return bearerToken(req);
  return req.viewer?.via === 'session' ? sessionToken(req) : null;
}

/**
 * Révoque la session courante : celle du Bearer (aucun cookie à effacer), sinon celle du cookie s'il existe, et efface
 * le cookie.
 */
export function endSession(req: FastifyRequest, reply: FastifyReply): void {
  const { db } = req.server.data;
  if (req.viewer?.via === 'bearer') {
    const token = bearerToken(req);
    if (token) revokeSession(db, token);
    return;
  }
  const token = sessionToken(req);
  if (token) revokeSession(db, token);
  reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

/** Membre connecté d'une route protégée (le garde global a déjà renvoyé 401 sinon). */
export function viewerOf(req: FastifyRequest): SessionViewer {
  if (!req.viewer) throw new HttpError(401, 'Connexion requise');
  return req.viewer;
}

/**
 * preHandler : 403 si le membre n'a aucun de ces droits (sauf route d'amorçage encore ouverte, avec le jeton
 * d'installation).
 */
export const requireCapability =
  (...capabilities: [keyof Capabilities, ...(keyof Capabilities)[]]) =>
  async (req: FastifyRequest) => {
    if (isBootstrap(req)) return;
    if (!capabilities.some((capability) => req.viewer?.capabilities[capability]))
      throw new HttpError(403, 'Accès refusé');
  };

/** Options d'une route réservée au propriétaire (le serveur multimédia reste ouvert pendant l'amorçage, `isBootstrap`). */
export const ownerOnly = { preHandler: requireCapability('isOwner') };

/**
 * preHandler : 403 si la requête s'est authentifiée par clé d'API (réservé aux sessions : une clé ne crée pas de clé et
 * ne gère pas de sessions). Un jeton Bearer passe : c'est la session d'un membre, pas une clé.
 */
export const forbidApiKey = async (req: FastifyRequest) => {
  if (req.viewer?.via === 'apiKey') throw new HttpError(403, 'Cette route n’accepte pas les clés d’API');
};

/**
 * preHandler : réservé aux sessions par cookie, ni clé d'API ni Bearer. Un jeton Bearer volé ne doit pas pouvoir créer
 * une clé qui survivrait à la révocation de la session.
 */
export const forbidHeaderCredentials = async (req: FastifyRequest) => {
  await forbidApiKey(req);
  if (req.viewer?.via === 'bearer') throw new HttpError(403, 'Cette route n’accepte pas les jetons Bearer');
};

/**
 * Cookies signés, membre de la session (cookie ou Bearer) ou de la clé d'API sur `req.viewer`, et garde global de
 * `/api` : toute route est protégée par défaut (401), les exceptions sont listées ci-dessus. Les écritures à cookie
 * passent le contrôle CSRF (403).
 * Une adresse sans route garde son 404.
 */
export async function registerAuth(app: FastifyInstance, { setupToken }: { setupToken: string }) {
  // Clé de signature dérivée de la clé de chiffrement : rien de plus à stocker.
  const secret = createHmac('sha256', app.data.cryptoKey).update('request:cookie').digest();
  await app.register(fastifyCookie, { secret });
  app.decorateRequest('viewer', null);
  app.decorate('setupToken', setupToken);

  // Par instance : chaque application (et chaque test) a ses propres compteurs.
  const headerLimiters: Record<HeaderVia, RateLimiter> = {
    apiKey: createRateLimiter(API_KEY_LIMIT),
    bearer: createRateLimiter(BEARER_LIMIT),
  };
  const setupTokenLimiter = createRateLimiter(SETUP_TOKEN_LIMIT);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url?.startsWith('/api/') || WEBHOOK_ROUTES.has(routeKey(req))) return;
    // Avant le CSRF, ni `X-Request` ni origine exigés : le CSRF abuse d'un justificatif que le navigateur joint de
    // lui-même (le cookie). Une clé ou un jeton Bearer n'est envoyé que par le code qui le détient, et une requête qui
    // en porte un n'a pas de cookie (refus 400 sinon) : un autre site ne peut rien faire en son nom.
    const via = headerViaOf(req);
    if (via) {
      const refused = authenticateWithHeader(req, reply, via, headerLimiters[via]);
      if (refused) return refused;
      // Clé valide mais hors de sa portée : 403, sans compter dans la limite des clés invalides.
      if (isOutOfScope(req)) return reply.code(403).send({ error: OUT_OF_SCOPE_ERROR });
      return;
    }
    if (!NATIVE_ROUTES.has(routeKey(req)) && !passesCsrf(req))
      return reply.code(403).send({ error: 'Requête refusée' });
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
