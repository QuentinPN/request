import type { FastifyPluginAsync } from 'fastify';
import { WATCH_LINK_PATH, type WatchLinkResponse } from '../../shared/media-server.ts';

/** De quoi bâtir « Regarder dans… » : lisible par tout membre connecté (ni l'id du serveur ni l'adresse publique ne sont des secrets). */
export const mediaServerRoutes: FastifyPluginAsync = async (app) => {
  app.get(WATCH_LINK_PATH, async (): Promise<WatchLinkResponse> => ({ link: await app.availability.watchLink() }));
};
