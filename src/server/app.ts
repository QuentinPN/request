import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type RouteOptions } from 'fastify';
import { API_FEATURES, API_VERSION, API_VERSION_PATH, type ApiVersion } from '../shared/api-version.ts';
import { HEALTH_PATH, type Health } from '../shared/health.ts';
import { SERVICE_WORKER_PATH } from '../shared/notifications.ts';
import { normalizeUrl } from '../shared/settings.ts';
import type { Data } from './db/index.ts';
import type { TmdbClient } from './integrations/tmdb.ts';
import { apiErrorHandler, HttpError } from './lib/api-errors.ts';
import { version } from './lib/build-info.ts';
import { createLogBuffer, type LogBuffer, redactRequestUrl, serializeRequest } from './lib/log-buffer.ts';
import { setAppLog } from './lib/logger.ts';
import { parseSetupToken, registerAuth } from './plugins/auth.ts';
import { aboutRoutes } from './routes/about.ts';
import { agentRoutes } from './routes/agents.ts';
import { apiKeysRoutes } from './routes/api-keys.ts';
import { arrServersRoutes } from './routes/arr-servers.ts';
import { authRoutes } from './routes/auth.ts';
import { blocklistRoutes } from './routes/blocklist.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { discoverSettingsRoutes } from './routes/discover-settings.ts';
import { generalRoutes } from './routes/general.ts';
import { imageRoutes } from './routes/images.ts';
import { importRoutes } from './routes/import.ts';
import { issuesRoutes } from './routes/issues.ts';
import { maintenanceRoutes } from './routes/maintenance.ts';
import { mediaServerRoutes } from './routes/media-server.ts';
import { notificationsRoutes } from './routes/notifications.ts';
import { overrideRulesRoutes } from './routes/override-rules.ts';
import { pushRoutes } from './routes/push.ts';
import { requestsRoutes } from './routes/requests.ts';
import { setupRoutes } from './routes/setup.ts';
import { smtpRoutes } from './routes/smtp.ts';
import { statsRoutes } from './routes/stats.ts';
import { usersRoutes } from './routes/users.ts';
import { watchlistRoutes } from './routes/watchlist.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { type AfterCommit, createAfterCommit } from './services/after-commit.ts';
import { type AgentsService, createAgents } from './services/agents.ts';
import { adoptLegacyArrSettings } from './services/arr-servers.ts';
import { type AvailabilityService, createAvailability } from './services/availability.ts';
import { createBackups, parseBackupKeep } from './services/backup.ts';
import { createDelivery } from './services/delivery.ts';
import { createEmail, type MailTransport, smtpTransport } from './services/email.ts';
import { createImageCache, parseImageCacheMaxBytes } from './services/images.ts';
import { createJobCenter, scanIntervalsOf } from './services/job-center.ts';
import { failOrphanJobs } from './services/jobs.ts';
import { createMediaServers, type MediaServers } from './services/media-server.ts';
import { createNotifications, onNotificationsCreated, onRequestEvent } from './services/notifications.ts';
import { createPush, type PushSender, vapidSubject, webPushSender } from './services/push.ts';
import { failInterruptedSends } from './services/requests.ts';
import { createSync, startScheduler } from './services/sync.ts';
import { createTmdbProvider } from './services/tmdb.ts';

declare module 'fastify' {
  interface FastifyInstance {
    data: Data;
    /** Client TMDB d'après le réglage courant ; lève `NotConfiguredError` tant que TMDB n'est pas configuré. */
    tmdb: () => TmdbClient;
    /** Serveur multimédia choisi (Emby, Jellyfin ou Plex), d'après le réglage courant. */
    mediaServers: MediaServers;
    /** Statut de disponibilité des titres (serveur multimédia, Radarr, Sonarr), en cache dans `media`. */
    availability: AvailabilityService;
    /** Agents de notification (Discord, ntfy, Telegram, webhook sortant), facultatifs. */
    agents: AgentsService;
    /** Envois des notifications après validation (agents, courriel, push) ; les tests les attendent avec `idle()`. */
    afterCommit: AfterCommit;
    /** Journal en mémoire (dernières lignes de `app.log`, expurgées des secrets), lu par Réglages › Journaux. */
    logs: LogBuffer;
  }
}

/** Services amont remplaçables (tests) ; par défaut, les vrais services TMDB, Discord, SMTP et push. */
export interface Upstreams {
  tmdbUrl?: string;
  imagesUrl?: string;
  /** Remplace l'hôte des webhooks Discord ; l'adresse enregistrée reste, elle, celle de discord.com. */
  discordUrl?: string;
  /** Remplace l'hôte de l'API Telegram (api.telegram.org) ; le jeton du bot reste dans le chemin. */
  telegramUrl?: string;
  /** Remplace l'API publique de Trakt (import des listes de souhaits). */
  traktUrl?: string;
  /** Remplace plex.tv (code PIN de connexion, comptes et amis du propriétaire d'un serveur Plex). */
  plexTvUrl?: string;
  /** Faux transport SMTP (messages gardés pour les assertions). */
  mailTransport?: MailTransport;
  /** Faux envoi push (`web-push` simulé). */
  pushSender?: PushSender;
}

/** Adresse publique de l'appli (`PUBLIC_URL`, ex. `https://demandes.example.com`), sans `/` final ; `null` si absente. */
export function parsePublicUrl(env: string | undefined): string | null {
  const value = env?.trim();
  return value && URL.canParse(value) ? normalizeUrl(value) : null;
}

const root = resolve(import.meta.dirname, '../..');

/** `/api`, `/api/...` et `/api?...` appartiennent à l'API, jamais à la SPA. */
export const isApiPath = (url: string) => /^\/api(?:[/?]|$)/.test(url);

/**
 * Proxys dont on croit `X-Forwarded-For/Proto/Host` (IP du client pour la limite de connexion, HTTPS pour le
 * cookie `secure`, hôte pour le contrôle d'origine) : la boucle locale, plus `TRUST_PROXY` (adresses ou CIDR
 * séparés par des virgules, ex. celle du conteneur Caddy). Tout autre appelant est pris tel quel.
 */
export function parseTrustProxy(env: string | undefined): string[] {
  const extra = (env ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ['127.0.0.1', '::1', ...extra];
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

/** Construit l'application sans écouter de port : réutilisée par le serveur, le dev Vite et les tests. */
export async function buildApp({
  clientDir,
  data,
  upstreams = {},
  schedule = false,
  onRoute,
  publicUrl = parsePublicUrl(process.env.PUBLIC_URL),
  setupToken = parseSetupToken(process.env.SETUP_TOKEN),
}: {
  clientDir?: string;
  data: Data;
  upstreams?: Upstreams;
  /** Lien des courriels et contact VAPID ; par défaut `PUBLIC_URL`. */
  publicUrl?: string | null;
  /** Jeton d'installation exigé par l'amorçage ; par défaut `SETUP_TOKEN`, sinon tiré au hasard. */
  setupToken?: string;
  /** Balayages planifiés (services/sync.ts) : le serveur seulement, jamais les tests. */
  schedule?: boolean;
  /** Appelé pour chaque route enregistrée, plugins compris (test du document OpenAPI). */
  onRoute?: (route: RouteOptions) => void;
}) {
  // Journal en mémoire : pino écrit dans le tampon, la sortie standard n'en reçoit une copie expurgée que sur le serveur (`schedule`), pour les journaux Docker. Pas de ligne par requête (les affiches
  // et l'actualisation des journaux eux-mêmes noieraient le tampon) : seulement le hook `onResponse`, les tâches et les erreurs.
  const logs = createLogBuffer(undefined, schedule ? (line) => process.stdout.write(line) : undefined);
  const app = Fastify({
    logger: { level: 'info', stream: logs, serializers: { req: serializeRequest } },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy,
  });
  // Avant toute route : les plugins enregistrés ensuite héritent du hook.
  if (onRoute) app.addHook('onRoute', onRoute);
  app.decorate('logs', logs);
  setAppLog(app.log);
  app.decorate('data', data);
  app.decorate('tmdb', createTmdbProvider(data, upstreams.tmdbUrl));
  app.decorate(
    'mediaServers',
    createMediaServers(data, { ...(upstreams.plexTvUrl && { plexTvUrl: upstreams.plexTvUrl }) }),
  );
  app.decorate('availability', createAvailability(data, { tmdb: app.tmdb, mediaServers: app.mediaServers }));
  // Démarrage : une tâche restée « en cours », ou un envoi de demande, a été interrompu par l'arrêt précédent.
  failOrphanJobs(data.db);
  failInterruptedSends(data.db);
  adoptLegacyArrSettings(data.db);
  const sync = createSync(data, { availability: app.availability, mediaServers: app.mediaServers, log: app.log });
  const scheduler = schedule ? startScheduler(sync, data.db, { intervals: () => scanIntervalsOf(data) }) : null;
  const backups = createBackups(data.db, data.dir, parseBackupKeep(process.env.BACKUP_KEEP), { log: app.log });
  const backupTimer = schedule && backups.enabled ? backups.start() : null;
  const jobs = createJobCenter(data, { sync, backups, scheduler, backupTimer });
  // Canaux de notification : l'appli (`notify`), puis Discord, courriel et push après la validation de la transaction.
  const afterCommit = createAfterCommit();
  app.decorate('afterCommit', afterCommit);
  const agents = createAgents(data, {
    tmdb: app.tmdb,
    afterCommit,
    ...(upstreams.discordUrl && { discordUrl: upstreams.discordUrl }),
    ...(upstreams.telegramUrl && { telegramUrl: upstreams.telegramUrl }),
  });
  app.decorate('agents', agents);
  const notificationService = createNotifications(data, { tmdb: app.tmdb });
  const email = createEmail(data, { transport: upstreams.mailTransport ?? smtpTransport, publicUrl });
  const push = createPush(data, { send: upstreams.pushSender ?? webPushSender, subject: vapidSubject(publicUrl) });
  const delivery = createDelivery(data, { afterCommit, notifications: notificationService, email, push });
  const unsubscribe = [onRequestEvent(agents.enqueue), onNotificationsCreated(delivery.enqueue)];
  // Le balayage, la sauvegarde et les envois de notifications en cours finissent avant la fermeture de la base.
  app.addHook('onClose', async () => {
    for (const stop of unsubscribe) stop();
    await scheduler?.stop();
    await backupTimer?.stop();
    await jobs.idle();
    await afterCommit.idle();
    data.db.$client.close();
  });
  app.setErrorHandler(apiErrorHandler);
  // Journal : une ligne par réponse refusée ou en échec (le 404 d'une adresse inconnue et le 401 d'une lecture sans session, bruit
  // habituel, exceptés), adresse expurgée des secrets (`?token=`).
  app.addHook('onResponse', async (req, reply) => {
    const { statusCode } = reply;
    if (statusCode < 400 || statusCode === 404 || (statusCode === 401 && req.method === 'GET')) return;
    const path = redactRequestUrl(req.url).split('?')[0];
    req.log[statusCode >= 500 ? 'error' : 'warn'](
      { req, statusCode, responseTimeMs: Math.round(reply.elapsedTime) },
      `${req.method} ${path} : ${statusCode}`,
    );
  });
  // Avant toute route : le garde de /api couvre aussi les plugins enregistrés ensuite (catalogue, images).
  await registerAuth(app, { setupToken });

  // Santé : le processus répond et la base aussi (requête triviale), pour le HEALTHCHECK de l'image.
  app.get(HEALTH_PATH, async (): Promise<Health> => {
    try {
      data.db.$client.prepare('select 1').get();
    } catch {
      throw new HttpError(503, 'Base de données indisponible');
    }
    return { status: 'ok', version };
  });
  // Version du contrat d'API et capacités, publiques : les clients natifs y détectent un serveur trop ancien.
  app.get(
    API_VERSION_PATH,
    async (): Promise<ApiVersion> => ({ apiVersion: API_VERSION, features: [...API_FEATURES] }),
  );
  authRoutes(app);
  setupRoutes(app);
  arrServersRoutes(app);
  usersRoutes(app);
  requestsRoutes(app);
  issuesRoutes(app);
  notificationsRoutes(app, { service: notificationService, email, push });
  pushRoutes(app, push);
  agentRoutes(app, agents);
  smtpRoutes(app, email);
  webhookRoutes(app, sync);
  apiKeysRoutes(app);
  importRoutes(app);
  watchlistRoutes(app, upstreams);
  statsRoutes(app);
  blocklistRoutes(app);
  discoverSettingsRoutes(app);
  generalRoutes(app);
  aboutRoutes(app);
  overrideRulesRoutes(app);
  await app.register(catalogueRoutes);
  await app.register(mediaServerRoutes);
  const images = createImageCache({
    dir: data.dir,
    maxBytes: parseImageCacheMaxBytes(process.env.IMAGE_CACHE_MAX_MB),
    ...(upstreams.imagesUrl && { upstreamUrl: upstreams.imagesUrl }),
  });
  maintenanceRoutes(app, { jobs, images, logs });
  await app.register(imageRoutes(images));

  const hasClient = clientDir !== undefined && existsSync(clientDir);
  if (hasClient)
    await app.register(fastifyStatic, {
      root: clientDir,
      wildcard: false,
      // Le service worker est relu à chaque visite : une nouvelle version de l'appli le remplace sans attendre.
      setHeaders: (reply, path) => {
        if (basename(path) === basename(SERVICE_WORKER_PATH)) reply.header('cache-control', 'no-cache');
      },
    });
  // /api inconnu : 404 JSON. Hors /api : index.html (SPA) si le client est construit, sinon 404 JSON.
  app.setNotFoundHandler((req, reply) =>
    hasClient && !isApiPath(req.url) ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Introuvable' }),
  );
  return app;
}

export const clientDir = resolve(root, 'dist/client');
export const dataDir = resolve(process.env.DATA_DIR ?? resolve(root, 'data'));
