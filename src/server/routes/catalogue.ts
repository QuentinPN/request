import type { FastifyPluginAsync } from 'fastify';
import {
  discoverRowSchema,
  genresResponseSchema,
  pagedMediaSchema,
  pageQuerySchema,
  providersResponseSchema,
  searchQuerySchema,
  typeIdParamsSchema,
  typeParamsSchema,
} from '../../shared/catalogue.ts';
import { keyOf, type MediaSummary, mediaSearchResultsSchema } from '../../shared/media.ts';
import { parseRequest, parseUpstream } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import { withStatus } from '../services/availability.ts';
import { blockOf, excludedKeywordIds, forViewer } from '../services/blocklist.ts';
import { hiddenInDiscover } from '../services/discover.ts';
import { loadDetails } from '../services/tmdb.ts';

const SERVICE = 'TMDB';
/** Rangée de titres déjà dans la bibliothèque : « Masquer les disponibles » la viderait, elle n'y est pas soumise. */
const LIBRARY_ROW = 'emby-recent';

/** API du catalogue TMDB : rangées Découvrir, genres, plateformes, recherche et fiches, avec le statut de chaque titre. */
export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/discover', async (req) => {
    const tmdb = app.tmdb();
    const viewer = viewerOf(req);
    const { id: userId } = viewer.user;
    // Ordre de PRODUCT.md ; « Ajoutés récemment dans Emby » est omise tant qu'Emby n'est pas configuré (`null`).
    const rows: Array<{ id: string; title: string; load: () => Promise<MediaSummary[] | null> }> = [
      { id: 'trending', title: 'Tendances', load: () => tmdb.trendingAll('week') },
      { id: 'popular-movies', title: 'Films populaires', load: () => tmdb.popular('movie') },
      { id: 'popular-tv', title: 'Séries populaires', load: () => tmdb.popular('tv') },
      { id: 'upcoming', title: 'Prochainement', load: () => tmdb.upcoming() },
      { id: 'emby-recent', title: 'Ajoutés récemment dans Emby', load: () => app.availability.recentlyAdded(userId) },
    ];
    const settled = await Promise.allSettled(
      rows.map(async ({ id, title, load }) => {
        const items = await load();
        return items && parseUpstream(SERVICE, discoverRowSchema, { id, title, items });
      }),
    );
    // Une rangée en échec (ou hors contrat) est omise ; si aucune ne reste, l'erreur remonte (une page vide cacherait la panne).
    const fetched = settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed && fetched.length === 0) throw failed.reason;
    // Titres bloqués retirés (membres) ou marqués (gestionnaires), puis statuts de toutes les rangées en un seul lot.
    const loaded = fetched.map((row) => ({ ...row, items: forViewer(app.data.db, viewer, row.items) }));
    const statuses = await app.availability.statusesFor(loaded.flatMap((row) => row.items));
    // « Masquer dans Découvrir » (disponibles, déjà demandés) ; une rangée vidée par ces filtres est omise.
    const hidden = hiddenInDiscover(
      app.data,
      loaded.filter((row) => row.id !== LIBRARY_ROW).flatMap((row) => row.items),
      statuses,
    );
    return {
      rows: loaded.flatMap((row, i) => {
        const items = row.items.filter((item) => !hidden.has(keyOf(item)));
        return items.length === 0 && fetched[i]?.items.length
          ? []
          : [{ ...row, items: items.map((item) => withStatus(statuses, item)) }];
      }),
    };
  });

  for (const [segment, method] of [
    ['genre', 'byGenre'],
    ['provider', 'discoverByProvider'],
  ] as const) {
    app.get(`/api/discover/:type/${segment}/:id`, async (req) => {
      const { type, id } = parseRequest(typeIdParamsSchema, req.params);
      const { page } = parseRequest(pageQuerySchema, req.query);
      const viewer = viewerOf(req);
      // Flux `/discover` : les mots-clés bloqués sont écartés par TMDB (membres seulement).
      const raw = await app.tmdb()[method](type, id, page, excludedKeywordIds(app.data, viewer));
      const paged = parseUpstream(SERVICE, pagedMediaSchema, raw);
      const results = forViewer(app.data.db, viewer, paged.results);
      return { ...paged, results: await app.availability.withStatuses(results) };
    });
  }

  app.get('/api/genres/:type', async (req) => {
    const { type } = parseRequest(typeParamsSchema, req.params);
    return parseUpstream(SERVICE, genresResponseSchema, { genres: await app.tmdb().genres(type) });
  });

  app.get('/api/providers/:type', async (req) => {
    const { type } = parseRequest(typeParamsSchema, req.params);
    return parseUpstream(SERVICE, providersResponseSchema, { providers: await app.tmdb().providers(type) });
  });

  app.get('/api/search', async (req) => {
    const { q, page } = parseRequest(searchQuerySchema, req.query);
    const found = parseUpstream(SERVICE, mediaSearchResultsSchema, await app.tmdb().searchMulti(q, page));
    const results = forViewer(app.data.db, viewerOf(req), found.results);
    return { ...found, results: await app.availability.withStatuses(results) };
  });

  app.get('/api/media/:type/:id', async (req) => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    const details = await app.availability.withDetailsStatus(await loadDetails(app.tmdb(), type, id));
    const blocked = blockOf(app.data, details);
    return blocked ? { ...details, blocked } : details;
  });
};
