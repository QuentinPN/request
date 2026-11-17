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
import { mediaDetailsSchema, mediaSearchResultsSchema } from '../../shared/media.ts';
import { IntegrationError } from '../integrations/http.ts';
import { parseRequest, parseUpstream } from '../lib/api-errors.ts';

const SERVICE = 'TMDB';

/** API du catalogue TMDB : rangées Découvrir, genres, plateformes, recherche et fiches. */
export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/discover', async () => {
    const tmdb = app.tmdb();
    // Ordre de PRODUCT.md. Les rangées « Ajoutés récemment dans Emby » viendront avec la tâche 3.2.
    const rows = [
      { id: 'trending', title: 'Tendances', load: () => tmdb.trendingAll('week') },
      { id: 'popular-movies', title: 'Films populaires', load: () => tmdb.popular('movie') },
      { id: 'popular-tv', title: 'Séries populaires', load: () => tmdb.popular('tv') },
      { id: 'upcoming', title: 'Prochainement', load: () => tmdb.upcoming() },
    ];
    const settled = await Promise.allSettled(
      rows.map(async ({ id, title, load }) =>
        parseUpstream(SERVICE, discoverRowSchema, { id, title, items: await load() }),
      ),
    );
    // Une rangée en échec (ou hors contrat) est omise ; si tout échoue, l'erreur remonte (une page vide cacherait la panne).
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed && settled.every((r) => r.status === 'rejected')) throw failed.reason;
    return { rows: settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])) };
  });

  for (const [segment, method] of [
    ['genre', 'byGenre'],
    ['provider', 'discoverByProvider'],
  ] as const) {
    app.get(`/api/discover/:type/${segment}/:id`, async (req) => {
      const { type, id } = parseRequest(typeIdParamsSchema, req.params);
      const { page } = parseRequest(pageQuerySchema, req.query);
      return parseUpstream(SERVICE, pagedMediaSchema, await app.tmdb()[method](type, id, page));
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
    return parseUpstream(SERVICE, mediaSearchResultsSchema, await app.tmdb().searchMulti(q, page));
  });

  app.get('/api/media/:type/:id', async (req, reply) => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    try {
      return parseUpstream(SERVICE, mediaDetailsSchema, await app.tmdb().details(type, id));
    } catch (err) {
      if (err instanceof IntegrationError && err.kind === 'not_found')
        return reply.code(404).send({ error: 'Titre introuvable' });
      throw err;
    }
  });
};
