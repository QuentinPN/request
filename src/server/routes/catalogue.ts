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
import {
  type MediaDetails,
  type MediaSummary,
  mediaDetailsSchema,
  mediaSearchResultsSchema,
} from '../../shared/media.ts';
import { IntegrationError } from '../integrations/http.ts';
import { parseRequest, parseUpstream } from '../lib/api-errors.ts';
import { withStatus } from '../services/availability.ts';

const SERVICE = 'TMDB';

/** API du catalogue TMDB : rangées Découvrir, genres, plateformes, recherche et fiches, avec le statut de chaque titre. */
export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/discover', async () => {
    const tmdb = app.tmdb();
    // Ordre de PRODUCT.md ; « Ajoutés récemment dans Emby » est omise tant qu'Emby n'est pas configuré (`null`).
    const rows: Array<{ id: string; title: string; load: () => Promise<MediaSummary[] | null> }> = [
      { id: 'trending', title: 'Tendances', load: () => tmdb.trendingAll('week') },
      { id: 'popular-movies', title: 'Films populaires', load: () => tmdb.popular('movie') },
      { id: 'popular-tv', title: 'Séries populaires', load: () => tmdb.popular('tv') },
      { id: 'upcoming', title: 'Prochainement', load: () => tmdb.upcoming() },
      { id: 'emby-recent', title: 'Ajoutés récemment dans Emby', load: () => app.availability.recentlyAdded() },
    ];
    const settled = await Promise.allSettled(
      rows.map(async ({ id, title, load }) => {
        const items = await load();
        return items && parseUpstream(SERVICE, discoverRowSchema, { id, title, items });
      }),
    );
    // Une rangée en échec (ou hors contrat) est omise ; si aucune ne reste, l'erreur remonte (une page vide cacherait la panne).
    const loaded = settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed && loaded.length === 0) throw failed.reason;
    // Statuts de toutes les rangées en un seul lot.
    const statuses = await app.availability.statusesFor(loaded.flatMap((row) => row.items));
    return {
      rows: loaded.map((row) => ({ ...row, items: row.items.map((item) => withStatus(statuses, item)) })),
    };
  });

  for (const [segment, method] of [
    ['genre', 'byGenre'],
    ['provider', 'discoverByProvider'],
  ] as const) {
    app.get(`/api/discover/:type/${segment}/:id`, async (req) => {
      const { type, id } = parseRequest(typeIdParamsSchema, req.params);
      const { page } = parseRequest(pageQuerySchema, req.query);
      const paged = parseUpstream(SERVICE, pagedMediaSchema, await app.tmdb()[method](type, id, page));
      return { ...paged, results: await app.availability.withStatuses(paged.results) };
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
    return { ...found, results: await app.availability.withStatuses(found.results) };
  });

  app.get('/api/media/:type/:id', async (req, reply) => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    let details: MediaDetails;
    try {
      details = parseUpstream(SERVICE, mediaDetailsSchema, await app.tmdb().details(type, id));
    } catch (err) {
      if (err instanceof IntegrationError && err.kind === 'not_found')
        return reply.code(404).send({ error: 'Titre introuvable' });
      throw err;
    }
    return app.availability.withDetailsStatus(details);
  });
};
