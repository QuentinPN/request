import { asc, eq, max } from 'drizzle-orm';
import type { MediaType } from '../../shared/media.ts';
import {
  type OverrideRule,
  type OverrideRuleValues,
  overrideTitleOf,
  ruleMatches,
} from '../../shared/override-rules.ts';
import type { Data, Db } from '../db/index.ts';
import { overrideRules } from '../db/schema.ts';
import { arrKindOf } from '../integrations/arr.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError } from '../lib/api-errors.ts';
import { logWarn } from '../lib/logger.ts';
import { listArrServers, serversOf } from './arr-servers.ts';
import { loadDetails } from './tmdb.ts';

type Sources = Pick<Data, 'db' | 'cryptoKey'>;
type Row = typeof overrideRules.$inferSelect;

export const RULE_NOT_FOUND = 'Règle introuvable';

const toRule = ({ createdAt: _c, updatedAt: _u, ...row }: Row): OverrideRule => row;

/** Toutes les règles, dans l'ordre (la première qui correspond l'emporte). */
export const listOverrideRules = (db: Pick<Db, 'select'>): OverrideRule[] =>
  db.select().from(overrideRules).orderBy(asc(overrideRules.position), asc(overrideRules.id)).all().map(toRule);

/** Ajoute une règle en dernière position (cible déjà validée : `assertRuleTarget`). */
export function createOverrideRule(db: Db, values: OverrideRuleValues): OverrideRule {
  return db.transaction((tx) => {
    const last =
      tx
        .select({ position: max(overrideRules.position) })
        .from(overrideRules)
        .get()?.position ?? -1;
    return toRule(
      tx
        .insert(overrideRules)
        .values({ ...values, position: last + 1 })
        .returning()
        .get(),
    );
  });
}

export const getOverrideRule = (db: Pick<Db, 'select'>, id: number): OverrideRule | null => {
  const row = db.select().from(overrideRules).where(eq(overrideRules.id, id)).get();
  return row ? toRule(row) : null;
};

/** Remplace une règle (cible déjà validée : `assertRuleTarget`) ; elle garde sa position. */
export function updateOverrideRule(db: Db, id: number, values: OverrideRuleValues): OverrideRule {
  const updated = db
    .update(overrideRules)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(overrideRules.id, id))
    .returning()
    .get();
  if (!updated) throw new HttpError(404, RULE_NOT_FOUND);
  return toRule(updated);
}

export function deleteOverrideRule(db: Db, id: number) {
  const gone = db.delete(overrideRules).where(eq(overrideRules.id, id)).returning({ id: overrideRules.id }).get();
  if (!gone) throw new HttpError(404, RULE_NOT_FOUND);
}

/** Nouvel ordre : exactement les ids existants (sinon 400, la liste a changé entre-temps), du premier au dernier. */
export function reorderOverrideRules(db: Db, ids: readonly number[]): OverrideRule[] {
  return db.transaction((tx) => {
    const current = tx.select({ id: overrideRules.id }).from(overrideRules).all();
    const known = new Set(current.map((rule) => rule.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id)))
      throw new HttpError(400, 'L’ordre doit reprendre toutes les règles, une fois chacune');
    ids.forEach((id, position) => {
      tx.update(overrideRules).set({ position }).where(eq(overrideRules.id, id)).run();
    });
    return listOverrideRules(tx);
  });
}

/**
 * Règles qui valent pour un titre, dans l'ordre : actives, du type du titre, dont le serveur est de sa qualité (4K ou
 * non : un autre serveur ne peut pas le recevoir) et dont les conditions sont remplies par sa fiche TMDB (déjà en
 * cache à l'approbation). Sans règle candidate, aucun appel à TMDB. TMDB muet : on continue sans règle, avec un
 * avertissement dans les journaux.
 */
export async function matchingRules(
  data: Sources,
  tmdb: () => TmdbClient,
  type: MediaType,
  is4k: boolean,
  tmdbId: number,
): Promise<OverrideRule[]> {
  const servers = new Set(serversOf(listArrServers(data), arrKindOf(type), is4k).map((s) => s.id));
  const candidates = listOverrideRules(data.db).filter(
    (rule) => rule.enabled && rule.type === type && servers.has(rule.serverId),
  );
  if (candidates.length === 0) return [];
  try {
    const title = overrideTitleOf(await loadDetails(tmdb(), type, tmdbId));
    return candidates.filter((rule) => ruleMatches(rule, title));
  } catch (error) {
    logWarn(`Règles de surcharge ignorées pour ${type}/${tmdbId} : TMDB injoignable`, error);
    return [];
  }
}
