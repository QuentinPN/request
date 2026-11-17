import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pageQuerySchema, typeIdParamsSchema } from '../../shared/catalogue.ts';
import { type MaskedSetting, settingSchemas } from '../../shared/settings.ts';
import {
  addWatchlistSchema,
  type InWatchlist,
  importPath,
  importQuerySchema,
  letterboxdImportSchema,
  TRAKT_SETTINGS_PATH,
  traktImportSchema,
  WATCHLIST_ITEM_ROUTE,
  WATCHLIST_PATH,
  type WatchlistImportResult,
  type WatchlistPage,
} from '../../shared/watchlist.ts';
import { IntegrationError } from '../integrations/http.ts';
import { testTrakt } from '../integrations/trakt.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { createRateLimiter } from '../lib/rate-limit.ts';
import { requireCapability, viewerOf } from '../plugins/auth.ts';
import { getSetting, maskSetting, setSetting, withStoredSecrets } from '../services/settings.ts';
import { createWatchlist } from '../services/watchlist.ts';
import { createWatchlistImport } from '../services/watchlist-import.ts';

/**
 * Liste de souhaits : chaque membre lit et modifie la sienne (jamais celle d'un autre), ajout et retrait idempotents.
 * Import Trakt et Letterboxd (`?dryRun=1` : aperçu, rien n'est écrit). Le Client ID Trakt est un réglage du propriétaire.
 */
export const IMPORT_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

export function watchlistRoutes(app: FastifyInstance, upstreams: { traktUrl?: string } = {}) {
  const { db, cryptoKey } = app.data;
  const service = createWatchlist(db, { tmdb: app.tmdb, availability: app.availability });
  const importer = createWatchlistImport(app.data, {
    tmdb: app.tmdb,
    ...(upstreams.traktUrl && { traktUrl: upstreams.traktUrl }),
  });
  const ownerOnly = { preHandler: requireCapability('isOwner') };
  const userOf = (req: FastifyRequest) => viewerOf(req).user.id;
  // Par instance et par membre, aperçus compris : chaque import interroge Trakt ou TMDB.
  const importLimiter = createRateLimiter(IMPORT_LIMIT);
  const importGuard = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      const blocked = importLimiter.hit(userOf(req));
      if (!blocked) return;
      reply.header('retry-after', Math.ceil(blocked.retryAfterMs / 1000));
      throw new HttpError(429, 'Trop d’imports, réessayez dans quelques minutes');
    },
  };

  app.get(WATCHLIST_PATH, async (req): Promise<WatchlistPage> => {
    const { page } = parseRequest(pageQuerySchema, req.query);
    return service.list(userOf(req), page);
  });

  app.post(WATCHLIST_PATH, async (req): Promise<InWatchlist> => {
    const { type, tmdbId } = parseRequest(addWatchlistSchema, req.body);
    await service.add(userOf(req), type, tmdbId);
    return { inList: true };
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
    try {
      await testTrakt({ ...value, ...(upstreams.traktUrl && { baseUrl: upstreams.traktUrl }) });
    } catch (error) {
      if (error instanceof IntegrationError) throw new HttpError(422, error.message);
      throw error;
    }
    return maskSetting('trakt', setSetting(db, cryptoKey, 'trakt', value));
  });
}
