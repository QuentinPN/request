import type { FastifyInstance } from 'fastify';
import { GENERAL_SETTINGS_PATH } from '../../shared/app-info.ts';
import { type Setting, settingSchemas } from '../../shared/settings.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import { getGeneral, setSetting } from '../services/settings.ts';

/** Réglages › Général (propriétaire seulement) : le titre de l'appli. Il n'a rien de secret. */
export function generalRoutes(app: FastifyInstance) {
  const { db, cryptoKey } = app.data;

  app.get(GENERAL_SETTINGS_PATH, ownerOnly, async (): Promise<Setting<'general'>> => getGeneral(db, cryptoKey));

  app.put(
    GENERAL_SETTINGS_PATH,
    ownerOnly,
    async (req): Promise<Setting<'general'>> =>
      setSetting(db, cryptoKey, 'general', parseRequest(settingSchemas.general, req.body)),
  );
}
