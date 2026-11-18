import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginSchema } from '../../shared/auth.ts';
import {
  loginMethodOf,
  PLEX_PIN_CHECK_PATH,
  PLEX_PIN_PATH,
  type PlexPinCreated,
  type PlexPinState,
} from '../../shared/media-server.ts';
import { IntegrationError } from '../integrations/http.ts';
import { labelOf, type MediaServer, type MemberCredentials } from '../integrations/media-server.ts';
import { checkPlexPin, createPlexPin, type PlexPin, plexAuthUrl } from '../integrations/plex.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { createRateLimiter } from '../lib/rate-limit.ts';
import { endSession, refreshSessionCookie, startSession, viewerOf } from '../plugins/auth.ts';
import { toViewer, upsertFromEmby } from '../services/users.ts';

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
    reply.header('retry-after', Math.ceil(blocked.retryAfterMs / 1000));
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

  /** Authentifie le membre auprès du serveur, crée ou rafraîchit son compte et ouvre la session. */
  async function signIn(req: FastifyRequest, reply: FastifyReply, server: MediaServer, credentials: MemberCredentials) {
    const member = await server.authenticate(credentials).catch((error: unknown) => {
      if (error instanceof IntegrationError && error.kind === 'unauthorized')
        throw new HttpError(credentials.method === 'plex' && error.status === 403 ? 403 : 401, error.message);
      throw error;
    });
    const user = upsertFromEmby(app.data.db, {
      id: member.id,
      name: member.name,
      avatar: member.avatarUrl,
      isEmbyAdmin: member.isAdmin,
    });
    startSession(req, reply, user.id);
    return toViewer(user);
  }

  app.post('/api/auth/login', async (req, reply) => {
    limit(req, reply);
    const { username, password } = parseRequest(loginSchema, req.body);
    const server = serverFor('password');
    return { viewer: await signIn(req, reply, server, { method: 'password', username, password }) };
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
