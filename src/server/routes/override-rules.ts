import type { FastifyInstance } from 'fastify';
import {
  OVERRIDE_RULES_ORDER_PATH,
  OVERRIDE_RULES_PATH,
  type OverrideRule,
  overrideRuleIdParamsSchema,
  overrideRuleInputSchema,
  overrideRulePath,
  overrideRulesOrderSchema,
} from '../../shared/override-rules.ts';
import { HttpError, parseRequest } from '../lib/api-errors.ts';
import { ownerOnly } from '../plugins/auth.ts';
import {
  createOverrideRule,
  deleteOverrideRule,
  getOverrideRule,
  listOverrideRules,
  RULE_NOT_FOUND,
  reorderOverrideRules,
  updateOverrideRule,
} from '../services/override-rules.ts';
import { assertRuleTarget } from '../services/send-options.ts';

/**
 * Règles de surcharge (propriétaire seulement) : liste ordonnée, ajout, modification, suppression, nouvel ordre. Serveur
 * du type de la règle, profil et dossier existant sur ce serveur (`assertRuleTarget`), sinon 400.
 */
export function overrideRulesRoutes(app: FastifyInstance) {
  const { db } = app.data;
  const idOf = (params: unknown) => parseRequest(overrideRuleIdParamsSchema, params).id;

  app.get(OVERRIDE_RULES_PATH, ownerOnly, async (): Promise<OverrideRule[]> => listOverrideRules(db));

  app.post(OVERRIDE_RULES_PATH, ownerOnly, async (req, reply): Promise<OverrideRule> => {
    const values = parseRequest(overrideRuleInputSchema, req.body);
    await assertRuleTarget(app.data, values);
    reply.code(201);
    return createOverrideRule(db, values);
  });

  app.put(OVERRIDE_RULES_ORDER_PATH, ownerOnly, async (req): Promise<OverrideRule[]> =>
    reorderOverrideRules(db, parseRequest(overrideRulesOrderSchema, req.body).ids),
  );

  app.put(overrideRulePath(':id'), ownerOnly, async (req): Promise<OverrideRule> => {
    const id = idOf(req.params);
    const stored = getOverrideRule(db, id);
    if (!stored) throw new HttpError(404, RULE_NOT_FOUND);
    const values = parseRequest(overrideRuleInputSchema, req.body);
    await assertRuleTarget(app.data, values, stored);
    return updateOverrideRule(db, id, values);
  });

  app.delete(overrideRulePath(':id'), ownerOnly, async (req, reply) => {
    deleteOverrideRule(db, idOf(req.params));
    reply.code(204);
  });
}
