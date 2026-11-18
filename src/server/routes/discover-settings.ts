import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { DISCOVER_LAYOUT_PATH } from '../../shared/catalogue.ts';
import { discoverLayoutInputSchema } from '../../shared/discover-layout.ts';
import { type SettingInput, settingSchemas } from '../../shared/settings.ts';
import { TMDB_LOCALE_PATH } from '../../shared/tmdb-locale.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import { getSetting, setSetting } from '../services/settings.ts';

/**
 * Réglages du catalogue, propriétaire seulement : ordre, état et rangées sur mesure de Découvrir, langue et région de
 * TMDB. Jamais enregistrés : les valeurs par défaut du schéma. Les membres n'y accèdent pas : ils en voient l'effet.
 */
export function discoverSettingsRoutes(app: FastifyInstance) {
  const { db, cryptoKey } = app.data;
  const register = <K extends 'discoverLayout' | 'tmdbLocale'>(
    path: string,
    key: K,
    writeSchema: z.ZodType = settingSchemas[key],
  ) => {
    app.get(path, ownerOnly, async () => getSetting(db, cryptoKey, key) ?? settingSchemas[key].parse({}));
    app.put(path, ownerOnly, async (req) =>
      setSetting(db, cryptoKey, key, parseRequest(writeSchema, req.body) as SettingInput<K>),
    );
  };

  register(DISCOVER_LAYOUT_PATH, 'discoverLayout', discoverLayoutInputSchema);
  register(TMDB_LOCALE_PATH, 'tmdbLocale');
}
