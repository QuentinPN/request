import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BLOCKED_KEYWORDS_PATH,
  BLOCKED_TITLE_ROUTE,
  BLOCKED_TITLES_PATH,
  BLOCKLIST_PATH,
  type BlockedKeyword,
  type Blocklist,
  blockedKeywordSchema,
  blockTitleSchema,
  KEYWORD_SEARCH_PATH,
  keywordSearchQuerySchema,
} from '../../shared/blocklist.ts';
import { DISCOVER_SETTINGS_PATH, typeIdParamsSchema } from '../../shared/catalogue.ts';
import { type Setting, settingSchemas } from '../../shared/settings.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { ownerOnly, requireCapability, viewerOf } from '../plugins/auth.ts';
import { createBlocklist } from '../services/blocklist.ts';
import { getSetting, setSetting } from '../services/settings.ts';

const keywordsInputSchema = z.object({ keywords: z.array(blockedKeywordSchema).max(500) });

/**
 * Blocages (droit « Gérer les blocages ») : titres bloqués (liste, blocage, déblocage) et mots-clés TMDB (recherche,
 * liste enregistrée). Réglage « Masquer dans Découvrir » (propriétaire).
 */
export function blocklistRoutes(app: FastifyInstance) {
  const { db, cryptoKey } = app.data;
  const service = createBlocklist(app.data, { tmdb: app.tmdb });
  const canManage = { preHandler: requireCapability('canManageBlocklist') };

  app.get(BLOCKLIST_PATH, canManage, async (): Promise<Blocklist> => service.list());

  app.post(BLOCKED_TITLES_PATH, canManage, async (req): Promise<Blocklist> =>
    service.block(viewerOf(req).user.id, parseRequest(blockTitleSchema, req.body)),
  );

  app.delete(BLOCKED_TITLE_ROUTE, canManage, async (req): Promise<Blocklist> => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    return service.unblock({ type, tmdbId: id });
  });

  app.put(BLOCKED_KEYWORDS_PATH, canManage, async (req): Promise<Blocklist> =>
    service.setKeywords(parseRequest(keywordsInputSchema, req.body).keywords),
  );

  app.get(KEYWORD_SEARCH_PATH, canManage, async (req): Promise<BlockedKeyword[]> =>
    service.searchKeywords(parseRequest(keywordSearchQuerySchema, req.query).q),
  );

  app.get(
    DISCOVER_SETTINGS_PATH,
    ownerOnly,
    async (): Promise<Setting<'discover'>> =>
      getSetting(db, cryptoKey, 'discover') ?? settingSchemas.discover.parse({}),
  );

  app.put(DISCOVER_SETTINGS_PATH, ownerOnly, async (req): Promise<Setting<'discover'>> =>
    setSetting(db, cryptoKey, 'discover', parseRequest(settingSchemas.discover, req.body)),
  );
}
