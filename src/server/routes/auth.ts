import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AUTH_SESSIONS_PATH,
  type AuthSessions,
  authSessionParamsSchema,
  authSessionPath,
  type CurrentViewerResponse,
  EMBY_TOKEN_PATH,
  type EmbyTokenSession,
  embyTokenLoginSchema,
  LOGIN_PATH,
  LOGOUT_PATH,
  loginSchema,
  VIEWER_PATH,
} from '../../shared/auth.ts';
import {
  loginMethodOf,
  PLEX_PIN_CHECK_PATH,
  PLEX_PIN_PATH,
  type PlexPinCreated,
  type PlexPinState,
} from '../../shared/media-server.ts';
import { tokenRefused } from '../integrations/emby.ts';
import { IntegrationError } from '../integrations/http.ts';
import {
  labelOf,
  type MediaServer,
  type MediaServerUser,
  type MemberCredentials,
} from '../integrations/media-server.ts';
import { checkPlexPin, createPlexPin, type PlexPin, plexAuthUrl } from '../integrations/plex.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { createRateLimiter, setRetryAfter } from '../lib/rate-limit.ts';
import {
  currentSessionToken,
  endSession,
  forbidApiKey,
  refreshSessionCookie,
  startSession,
  viewerOf,
} from '../plugins/auth.ts';
import { createSession, listUserSessions, revokeUserSession } from '../services/sessions.ts';
import { memberDefaultsOf, toViewer, type User, upsertFromEmby } from '../services/users.ts';

export const LOGIN_LIMIT = { limit: 10, windowMs: 5 * 60_000 };
/** Codes PIN Plex en attente gardés au plus (les plus anciens oubliés d'abord) : la mémoire reste bornée. */
const MAX_PENDING_PINS = 500;
/** Cookie du code PIN en cours : signé, invisible au script, envoyé seulement aux routes du code PIN. */
const PLEX_PIN_COOKIE = 'request_plex_pin';
const PLEX_PIN_COOKIE_OPTIONS = {
  path: PLEX_PIN_PATH,
  httpOnly: true,
  sameSite: 'strict',
  secure: 'auto',
  signed: true,
} as const;

export function authRoutes(app: FastifyInstance) {
  // Par instance : chaque application (et chaque test) a son propre compteur.
  const loginLimiter = createRateLimiter(LOGIN_LIMIT);
  /**
   * Codes PIN créés par ce serveur, par secret aléatoire porté par le cookie signé du navigateur qui l'a demandé : le
   * navigateur ne voit jamais l'id plex.tv, et ne peut échanger que son propre code, une seule fois, avant expiration.
   */
  const pins = new Map<string, PlexPin>();
  /** Secrets dont l'échange est en cours (code retiré de `pins` le temps d'interroger plex.tv). */
  const checking = new Set<string>();

  /** Compte un essai pour l'adresse ; 429 si la limite est déjà atteinte. */
  function limit(req: FastifyRequest, reply: FastifyReply) {
    const blocked = loginLimiter.hit(req.ip);
    if (!blocked) return;
    setRetryAfter(reply, blocked);
    throw new HttpError(429, 'Trop de tentatives de connexion, réessayez dans quelques minutes');
  }

  /** Serveur configuré dont la connexion se fait par cette méthode, sinon 400 (l'écran de connexion s'est trompé). */
  function serverFor(method: MemberCredentials['method']): MediaServer {
    const server = app.mediaServers.require();
    if (loginMethodOf(server.kind) !== method)
      throw new HttpError(
        400,
        method === 'plex'
          ? `${labelOf(server)} se connecte avec un identifiant et un mot de passe`
          : 'Plex se connecte avec le bouton « Se connecter avec Plex »',
      );
    return server;
  }

  /**
   * Membre reconnu par le serveur multimédia (mot de passe, code PIN Plex ou jeton) : son compte est créé ou rafraîchi
   * selon les règles de `upsertFromEmby` (premier administrateur propriétaire, droits par défaut des nouveaux).
   */
  function admit(member: MediaServerUser): User {
    return upsertFromEmby(
      app.data.db,
      { id: member.id, name: member.name, avatar: member.avatarUrl, isEmbyAdmin: member.isAdmin },
      new Date(),
      memberDefaultsOf(app.data),
    );
  }

  /** Authentifie le membre auprès du serveur, crée ou rafraîchit son compte et ouvre la session. */
  async function signIn(req: FastifyRequest, reply: FastifyReply, server: MediaServer, credentials: MemberCredentials) {
    const member = await server.authenticate(credentials).catch((error: unknown) => {
      if (error instanceof IntegrationError && error.kind === 'unauthorized')
        throw new HttpError(credentials.method === 'plex' && error.status === 403 ? 403 : 401, error.message);
      throw error;
    });
    const user = admit(member);
    startSession(req, reply, user.id);
    return toViewer(user);
  }

  app.post(LOGIN_PATH, async (req, reply) => {
    limit(req, reply);
    const { username, password } = parseRequest(loginSchema, req.body);
    const server = serverFor('password');
    return { viewer: await signIn(req, reply, server, { method: 'password', username, password }) };
  });

  /**
   * Connexion d'un client natif (Viewer) par le jeton d'accès Emby ou Jellyfin d'un membre : le serveur multimédia
   * dit si le jeton vaut pour `userId` (`verifyUserToken` : `/Users/Me` chez Jellyfin, session de l'appareil de
   * vérification chez Emby). Échec fermé : jeton refusé, autre compte, appel ou compte inconnu du serveur → 401 ;
   * serveur injoignable → 502 comme `/login`. Le jeton n'est ni conservé ni journalisé. La session, nommée par
   * `deviceName`, revient dans le corps : aucun cookie.
   * Corps validé avant la limite (même compteur que `/login`) : un appel malformé, par exemple un formulaire d'un autre
   * site (route sans CSRF), ne consomme pas les essais de l'adresse ; la limite passe avant tout appel au serveur.
   */
  app.post(EMBY_TOKEN_PATH, async (req, reply): Promise<EmbyTokenSession> => {
    const { userId, accessToken, deviceName } = parseRequest(embyTokenLoginSchema, req.body);
    limit(req, reply);
    const server = app.mediaServers.current();
    if (!server || server.kind === 'plex')
      throw new HttpError(400, 'La connexion par jeton ne s’applique qu’à un serveur Emby ou Jellyfin');
    const member = await server.verifyUserToken(accessToken, userId).catch((error: unknown) => {
      if (!(error instanceof IntegrationError)) throw error;
      if (error.kind === 'unauthorized') throw new HttpError(401, error.message);
      if (error.kind === 'not_found') {
        req.log.warn(
          { service: error.service, status: error.status, url: error.url },
          'Connexion par jeton refusée : appel ou compte inconnu du serveur multimédia',
        );
        // Même refus qu'un jeton inconnu : rien à apprendre pour qui essaie.
        throw new HttpError(401, tokenRefused(error.service));
      }
      throw error;
    });
    const user = admit(member);
    const { token, expiresAt } = createSession(
      app.data.db,
      user.id,
      req.headers['user-agent'] ?? null,
      new Date(),
      deviceName,
    );
    return { token, expiresAt: expiresAt.toISOString(), viewer: toViewer(user) };
  });

  /** Connexion Plex, étape 1 : un code PIN plex.tv, à valider dans la fenêtre app.plex.tv que le navigateur ouvre. */
  app.post(PLEX_PIN_PATH, async (req, reply): Promise<PlexPinCreated> => {
    limit(req, reply);
    serverFor('plex');
    const { plex } = app.mediaServers;
    const pin = await createPlexPin(plex);
    const secret = randomBytes(32).toString('base64url');
    pins.set(secret, pin);
    for (const oldest of pins.keys()) {
      if (pins.size <= MAX_PENDING_PINS) break;
      pins.delete(oldest);
    }
    reply.setCookie(PLEX_PIN_COOKIE, secret, { ...PLEX_PIN_COOKIE_OPTIONS, expires: new Date(pin.expiresAt) });
    return { authUrl: plexAuthUrl(plex.clientId, pin.code), expiresAt: new Date(pin.expiresAt).toISOString() };
  });

  /**
   * Connexion Plex, étape 2 (interrogée par le navigateur) : le code est celui que désigne le cookie de ce navigateur.
   * `pending` tant qu'il n'est pas validé ; validé, le jeton du compte sert une fois à vérifier son accès au serveur
   * puis est oublié (jamais enregistré). Le code est retiré avant d'interroger plex.tv : deux échanges simultanés ne
   * peuvent pas le valider deux fois. Sans cookie valide : 403 ; code inconnu : 404 ; expiré : 410 ; compte sans accès
   * au serveur : 403.
   */
  app.post(PLEX_PIN_CHECK_PATH, async (req, reply): Promise<PlexPinState> => {
    const raw = req.cookies[PLEX_PIN_COOKIE];
    const cookie = raw === undefined ? null : req.unsignCookie(raw);
    if (!cookie?.valid || !cookie.value) throw new HttpError(403, 'Connexion Plex non commencée dans ce navigateur');
    const secret = cookie.value;
    const pin = pins.get(secret);
    if (!pin) {
      // Un autre échange de ce code est en cours : il dira lui-même s'il est validé.
      if (checking.has(secret)) return { status: 'pending' };
      throw new HttpError(404, 'Code de connexion Plex inconnu, recommencez');
    }
    const server = serverFor('plex');
    const done = () => reply.clearCookie(PLEX_PIN_COOKIE, PLEX_PIN_COOKIE_OPTIONS);
    const expired = () => {
      done();
      return new HttpError(410, 'Code de connexion Plex expiré, recommencez');
    };
    // Réservé : retiré de la liste pendant l'interrogation de plex.tv, remis seulement s'il attend encore.
    pins.delete(secret);
    if (pin.expiresAt <= Date.now()) throw expired();
    checking.add(secret);
    try {
      const token = await checkPlexPin(app.mediaServers.plex, pin).catch((error: unknown) => {
        // plex.tv ne connaît plus ce code (expiré de son côté).
        if (error instanceof IntegrationError && error.kind === 'not_found') throw expired();
        // Erreur passagère : le code attend toujours, le sondage suivant le reprendra.
        pins.set(secret, pin);
        throw error;
      });
      if (!token) {
        pins.set(secret, pin);
        return { status: 'pending' };
      }
      done();
      const viewer = await signIn(req, reply, server, { method: 'plex', token }).catch((error: unknown) => {
        // Un échange refusé compte comme une connexion échouée.
        if (error instanceof HttpError) loginLimiter.hit(req.ip);
        throw error;
      });
      return { status: 'authorized', viewer };
    } finally {
      checking.delete(secret);
    }
  });

  // En Bearer, révoque la session du jeton ; sinon celle du cookie, qui est effacé.
  app.post(LOGOUT_PATH, async (req, reply) => {
    endSession(req, reply);
    return reply.code(204).send();
  });

  /**
   * Sessions du membre connecté, par cookie ou par Bearer, quel que soit son rôle. Pas avec une clé d'API (403, comme la
   * gestion des clés) : une clé n'a pas de session, et une liste vide ferait croire que son créateur n'en a aucune.
   */
  const ownSessions = { preHandler: forbidApiKey };

  app.get(
    AUTH_SESSIONS_PATH,
    ownSessions,
    async (req): Promise<AuthSessions> => ({
      sessions: listUserSessions(app.data, viewerOf(req).user.id, currentSessionToken(req)),
    }),
  );

  /** Révoque une session du membre (la courante comprise) ; 404 si l'identifiant n'est pas celui d'une des siennes. */
  app.delete(authSessionPath(':id'), ownSessions, async (req, reply) => {
    const { id } = parseRequest(authSessionParamsSchema, req.params);
    if (!revokeUserSession(app.data, viewerOf(req).user.id, id)) throw new HttpError(404, 'Session introuvable');
    return reply.code(204).send();
  });

  // Appelée par le client au chargement : prolonge aussi le cookie.
  app.get(VIEWER_PATH, async (req, reply) => {
    const { user, apiKeyScope } = viewerOf(req);
    refreshSessionCookie(req, reply);
    return { viewer: toViewer(user), apiKeyScope } satisfies CurrentViewerResponse;
  });
}
