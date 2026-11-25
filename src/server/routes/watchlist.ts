import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pageQuerySchema, typeIdParamsSchema } from '../../shared/catalogue.ts';
import { type MaskedSetting, settingSchemas } from '../../shared/settings.ts';
import {
  type AddedToWatchlist,
  type AutoRequestSetting,
  addWatchlistSchema,
  autoRequestSettingSchema,
  type InWatchlist,
  importPath,
  importQuerySchema,
  letterboxdImportSchema,
  TRAKT_SETTINGS_PATH,
  traktImportSchema,
  WATCHLIST_AUTO_REQUEST_PATH,
  WATCHLIST_ITEM_ROUTE,
  WATCHLIST_PATH,
  type WatchlistImportResult,
  type WatchlistPage,
} from '../../shared/watchlist.ts';
import { testTrakt } from '../integrations/trakt.ts';
import { asTestResult, HttpError, parseRequest } from '../lib/api-errors.ts';
import { createRateLimiter, setRetryAfter } from '../lib/rate-limit.ts';
import { ownerOnly, requireCapability, viewerOf } from '../plugins/auth.ts';
import { createRequests } from '../services/requests.ts';
import { getSetting, maskSetting, setSetting, withStoredSecrets } from '../services/settings.ts';
import { setWatchlistAutoRequest } from '../services/users.ts';
import { createWatchlist } from '../services/watchlist.ts';
import { createAutoRequester } from '../services/watchlist-auto-request.ts';
import { createWatchlistImport } from '../services/watchlist-import.ts';

/**
 * Liste de souhaits : chaque membre lit et modifie la sienne (jamais celle d'un autre), ajout et retrait idempotents.
 * Import Trakt et Letterboxd (`?dryRun=1` : aperçu, rien n'est écrit). Le Client ID Trakt est un réglage du propriétaire.
 */
export const IMPORT_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

export function watchlistRoutes(app: FastifyInstance, upstreams: { traktUrl?: string } = {}) {
  const { db, cryptoKey } = app.data;
  const service = createWatchlist(db, { tmdb: app.tmdb, availability: app.availability });
  const autoRequest = createAutoRequester({
    create: createRequests(app.data, { tmdb: app.tmdb, availability: app.availability }).create,
    onUnexpectedError: (error) => app.log.warn({ err: error }, 'Demande automatique depuis Ma liste impossible'),
  });
  const importer = createWatchlistImport(app.data, {
    tmdb: app.tmdb,
    ...(upstreams.traktUrl && { traktUrl: upstreams.traktUrl }),
  });
  const userOf = (req: FastifyRequest) => viewerOf(req).user.id;
  // Par instance et par membre, aperçus compris : chaque import interroge Trakt ou TMDB.
  const importLimiter = createRateLimiter(IMPORT_LIMIT);
  const importGuard = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const blocked = importLimiter.hit(userOf(req));
      if (!blocked) return;
      setRetryAfter(reply, blocked);
      throw new HttpError(429, 'Trop d’imports, réessayez dans quelques minutes');
    },
  };

  app.get(WATCHLIST_PATH, async (req): Promise<WatchlistPage> => {
    const { page } = parseRequest(pageQuerySchema, req.query);
    return service.list(userOf(req), page);
  });

  // Seul l'ajout à la main demande (jamais l'import) ; l'ajout réussit même si la demande est refusée.
  app.post(WATCHLIST_PATH, async (req): Promise<AddedToWatchlist> => {
    const { type, tmdbId } = parseRequest(addWatchlistSchema, req.body);
    const viewer = viewerOf(req);
    await service.add(viewer.user.id, type, tmdbId);
    const outcome = await autoRequest(viewer, type, tmdbId);
    return { inList: true, ...(outcome && { autoRequest: outcome }) };
  });

  // Option du membre ; sans le droit (retiré ou jamais accordé), lecture et écriture sont refusées (403).
  const canAutoRequest = { preHandler: requireCapability('canAutoRequestWatchlist') };
  app.get(WATCHLIST_AUTO_REQUEST_PATH, canAutoRequest, async (req): Promise<AutoRequestSetting> => ({
    enabled: viewerOf(req).user.watchlistAutoRequest,
  }));
  app.put(WATCHLIST_AUTO_REQUEST_PATH, canAutoRequest, async (req): Promise<AutoRequestSetting> => {
    const { enabled } = parseRequest(autoRequestSettingSchema, req.body);
    return { enabled: setWatchlistAutoRequest(db, userOf(req), enabled).watchlistAutoRequest };
  });

  app.get(WATCHLIST_ITEM_ROUTE, async (req): Promise<InWatchlist> => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    return { inList: service.has(userOf(req), { type, tmdbId: id }) };
  });

  app.delete(WATCHLIST_ITEM_ROUTE, async (req): Promise<InWatchlist> => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    service.remove(userOf(req), { type, tmdbId: id });
    return { inList: false };
  });

  app.post(importPath('trakt'), importGuard, async (req): Promise<WatchlistImportResult> => {
    const { dryRun } = parseRequest(importQuerySchema, req.query);
    const { username } = parseRequest(traktImportSchema, req.body);
    return importer.importTrakt(userOf(req), username, dryRun);
  });

  app.post(importPath('letterboxd'), importGuard, async (req): Promise<WatchlistImportResult> => {
    const { dryRun } = parseRequest(importQuerySchema, req.query);
    const { csv } = parseRequest(letterboxdImportSchema, req.body);
    return importer.importLetterboxd(userOf(req), csv, dryRun);
  });

  // Réglage du propriétaire : le Client ID, un secret, ne sort jamais du serveur.
  const stored = () => getSetting(db, cryptoKey, 'trakt');
  app.get(TRAKT_SETTINGS_PATH, ownerOnly, async (): Promise<MaskedSetting<'trakt'>> => {
    const value = stored();
    return value ? maskSetting('trakt', value) : { clientId: { set: false } };
  });
  app.put(TRAKT_SETTINGS_PATH, ownerOnly, async (req): Promise<MaskedSetting<'trakt'>> => {
    const input = withStoredSecrets('trakt', req.body, stored());
    const value = parseRequest(settingSchemas.trakt, input);
    await asTestResult(() => testTrakt({ ...value, ...(upstreams.traktUrl && { baseUrl: upstreams.traktUrl }) }));
    return maskSetting('trakt', setSetting(db, cryptoKey, 'trakt', value));
  });
}
