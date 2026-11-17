import type { FastifyPluginAsync } from 'fastify';
import { EMBY_LINK_PATH, type EmbyLinkResponse } from '../../shared/emby.ts';

/** De quoi bâtir « Regarder dans Emby » : lisible par tout membre connecté (l'adresse publique n'est pas un secret). */
export const embyRoutes: FastifyPluginAsync = async (app) => {
  app.get(EMBY_LINK_PATH, async (): Promise<EmbyLinkResponse> => ({ link: await app.availability.embyLink() }));
};
