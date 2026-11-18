import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Health } from '../shared/health.ts';
import { SERVICE_WORKER_PATH } from '../shared/notifications.ts';
import { normalizeUrl } from '../shared/settings.ts';
import type { Data } from './db/index.ts';
import type { TmdbClient } from './integrations/tmdb.ts';
import { apiErrorHandler, HttpError } from './lib/api-errors.ts';
import { registerAuth } from './plugins/auth.ts';
import { apiKeysRoutes } from './routes/api-keys.ts';
import { arrServersRoutes } from './routes/arr-servers.ts';
import { authRoutes } from './routes/auth.ts';
import { blocklistRoutes } from './routes/blocklist.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { discordRoutes } from './routes/discord.ts';
import { embyRoutes } from './routes/emby.ts';
import { imageRoutes } from './routes/images.ts';
import { importRoutes } from './routes/import.ts';
import { issuesRoutes } from './routes/issues.ts';
import { notificationsRoutes } from './routes/notifications.ts';
import { pushRoutes } from './routes/push.ts';
import { requestsRoutes } from './routes/requests.ts';
import { setupRoutes } from './routes/setup.ts';
import { smtpRoutes } from './routes/smtp.ts';
import { statsRoutes } from './routes/stats.ts';
import { usersRoutes } from './routes/users.ts';
import { watchlistRoutes } from './routes/watchlist.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { type AfterCommit, createAfterCommit } from './services/after-commit.ts';
import { adoptLegacyArrSettings } from './services/arr-servers.ts';
import { type AvailabilityService, createAvailability } from './services/availability.ts';
import { parseBackupKeep, startBackups } from './services/backup.ts';
import { createDelivery } from './services/delivery.ts';
import { createDiscord, type DiscordService } from './services/discord.ts';
import { createEmail, type MailTransport, smtpTransport } from './services/email.ts';
import { createImageCache, parseImageCacheMaxBytes } from './services/images.ts';
import { failOrphanJobs } from './services/jobs.ts';
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
    /** Statut de disponibilité des titres (Emby, Radarr, Sonarr), en cache dans `media`. */
    availability: AvailabilityService;
    /** Notifications Discord (facultatives). */
    discord: DiscordService;
    /** Envois des notifications après validation (Discord, courriel, push) ; les tests les attendent avec `idle()`. */
    afterCommit: AfterCommit;
  }
}

/** Services amont remplaçables (tests) ; par défaut, les vrais services TMDB, Discord, SMTP et push. */
export interface Upstreams {
  tmdbUrl?: string;
  imagesUrl?: string;
  /** Remplace l'hôte des webhooks Discord ; l'adresse enregistrée reste, elle, celle de discord.com. */
  discordUrl?: string;
  /** Remplace l'API publique de Trakt (import des listes de souhaits). */
  traktUrl?: string;
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
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

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
  publicUrl = parsePublicUrl(process.env.PUBLIC_URL),
}: {
  clientDir?: string;
  data: Data;
  upstreams?: Upstreams;
  /** Lien des courriels et contact VAPID ; par défaut `PUBLIC_URL`. */
  publicUrl?: string | null;
  /** Balayages planifiés (services/sync.ts) : le serveur seulement, jamais les tests. */
  schedule?: boolean;
}) {
  const app = Fastify({ logger: false, trustProxy });
  app.decorate('data', data);
  app.decorate('tmdb', createTmdbProvider(data, upstreams.tmdbUrl));
  app.decorate('availability', createAvailability(data, { tmdb: app.tmdb }));
  // Démarrage : une tâche restée « en cours », ou un envoi de demande, a été interrompu par l'arrêt précédent.
  failOrphanJobs(data.db);
  failInterruptedSends(data.db);
  adoptLegacyArrSettings(data.db);
  const sync = createSync(data, { availability: app.availability });
  const scheduler = schedule ? startScheduler(sync, data.db) : null;
  const backups = schedule ? startBackups(data.db.$client, data.dir, parseBackupKeep(process.env.BACKUP_KEEP)) : null;
  // Canaux de notification : l'appli (`notify`), puis Discord, courriel et push après la validation de la transaction.
  const afterCommit = createAfterCommit();
  app.decorate('afterCommit', afterCommit);
  const discord = createDiscord(data, {
    tmdb: app.tmdb,
    afterCommit,
    ...(upstreams.discordUrl && { baseUrl: upstreams.discordUrl }),
  });
  app.decorate('discord', discord);
  const notificationService = createNotifications(data, { tmdb: app.tmdb });
  const email = createEmail(data, { transport: upstreams.mailTransport ?? smtpTransport, publicUrl });
  const push = createPush(data, { send: upstreams.pushSender ?? webPushSender, subject: vapidSubject(publicUrl) });
  const delivery = createDelivery(data, { afterCommit, notifications: notificationService, email, push });
  const unsubscribe = [onRequestEvent(discord.enqueue), onNotificationsCreated(delivery.enqueue)];
  // Le balayage, la sauvegarde et les envois de notifications en cours finissent avant la fermeture de la base.
  app.addHook('onClose', async () => {
    for (const stop of unsubscribe) stop();
    await scheduler?.stop();
    await backups?.stop();
    await afterCommit.idle();
    data.db.$client.close();
  });
  app.setErrorHandler(apiErrorHandler);
  // Avant toute route : le garde de /api couvre aussi les plugins enregistrés ensuite (catalogue, images).
  await registerAuth(app);

  // Santé : le processus répond et la base aussi (requête triviale), pour le HEALTHCHECK de l'image.
  app.get('/api/health', async (): Promise<Health> => {
    try {
      data.db.$client.prepare('select 1').get();
    } catch {
      throw new HttpError(503, 'Base de données indisponible');
    }
    return { status: 'ok', version };
  });
  authRoutes(app);
  setupRoutes(app);
  arrServersRoutes(app);
  usersRoutes(app);
  requestsRoutes(app);
  issuesRoutes(app);
  notificationsRoutes(app, { service: notificationService, email, push });
  pushRoutes(app, push);
  discordRoutes(app, discord);
  smtpRoutes(app, email);
  webhookRoutes(app, sync);
  apiKeysRoutes(app);
  importRoutes(app);
  watchlistRoutes(app, upstreams);
  statsRoutes(app);
  blocklistRoutes(app);
  await app.register(catalogueRoutes);
  await app.register(embyRoutes);
  await app.register(
    imageRoutes(
      createImageCache({
        dir: data.dir,
        maxBytes: parseImageCacheMaxBytes(process.env.IMAGE_CACHE_MAX_MB),
        ...(upstreams.imagesUrl && { upstreamUrl: upstreams.imagesUrl }),
      }),
    ),
  );

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
