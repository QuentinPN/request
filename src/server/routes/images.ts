import type { FastifyPluginAsync } from 'fastify';
import { imageParamsSchema } from '../../shared/catalogue.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { type ImageCache, imageContentType } from '../services/images.ts';

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/** Proxy d'images TMDB avec cache disque : le navigateur ne dépend jamais directement de TMDB. */
export const imageRoutes =
  (images: ImageCache): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/images/:size/:file', async (req, reply) => {
      const { size, file } = parseRequest(imageParamsSchema, req.params);
      const body = await images.get(size, file);
      if (!body) return reply.code(404).send({ error: 'Image introuvable' });
      return (
        reply
          .type(imageContentType(file))
          .header('cache-control', `public, max-age=${THIRTY_DAYS_S}, immutable`)
          // Un SVG ouvert directement ne doit pouvoir exécuter aucun script sur l'origine de l'appli.
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
          .header('x-content-type-options', 'nosniff')
          .send(body)
      );
    });
  };
