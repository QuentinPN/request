import type { FastifyInstance } from 'fastify';
import {
  SEERR_IMPORT_PATH,
  type SeerrImportResult,
  seerrImportQuerySchema,
  seerrImportSchema,
} from '../../shared/import.ts';
import { fetchSeerrRequests } from '../integrations/seerr.ts';
import { parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import { importSeerrRequests } from '../services/seerr-import.ts';

/**
 * Import des demandes de Seerr (propriétaire) : adresse et clé servent à cet appel seulement, jamais enregistrées ni
 * renvoyées. Seerr injoignable ou clé refusée → 502 au message lisible (`IntegrationError`), rien d'écrit.
 */
export function importRoutes(app: FastifyInstance) {
  app.post(SEERR_IMPORT_PATH, ownerOnly, async (req): Promise<SeerrImportResult> => {
    const { dryRun } = parseRequest(seerrImportQuerySchema, req.query);
    const items = await fetchSeerrRequests(parseRequest(seerrImportSchema, req.body));
    return importSeerrRequests(app.data.db, items, { dryRun });
  });
}
