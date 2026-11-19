import { z } from 'zod';
import { blockedKeywordSchema } from './blocklist.ts';
import { type MediaDetails, mediaTypeSchema } from './media.ts';
import type { SendChoiceLayer } from './requests.ts';
import { profileId, rootFolderPath, seriesTypes } from './settings.ts';

// Règles de surcharge (Seerr `OverrideRule`) : « si le titre a tel genre, telle langue originale ou tel mot-clé TMDB,
// l'envoyer avec ce serveur, ce profil, ce dossier, ce type de série et ces étiquettes ». Sémantique : DECISIONS.md.

export const OVERRIDE_RULES_PATH = '/api/override-rules';
export const overrideRulePath = (id: number | string) => `${OVERRIDE_RULES_PATH}/${id}`;
/** Nouvel ordre des règles : tous les ids, du premier au dernier. */
export const OVERRIDE_RULES_ORDER_PATH = `${OVERRIDE_RULES_PATH}/order`;

const CONDITION_MAX = 50;
/** Langue originale TMDB : code ISO 639-1 (`ja`, `ko`), comme le filtre « Langue » de Découvrir. */
export const originalLanguageSchema = z.string().regex(/^[a-z]{2}$/, 'Code de langue à deux lettres attendu');
const conditionFields = {
  /** Ids des genres TMDB. */
  genres: z.array(z.number().int().positive()).max(CONDITION_MAX).default([]),
  languages: z.array(originalLanguageSchema).max(CONDITION_MAX).default([]),
  /** Mots-clés TMDB : l'id sert à la comparaison, le nom à l'affichage (comme les mots-clés bloqués). */
  keywords: z.array(blockedKeywordSchema).max(CONDITION_MAX).default([]),
};

/** Règle écrite par le propriétaire. Effets `null` : inchangés (valeur du niveau suivant, voir `resolveSendChoice`). */
export const overrideRuleInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Nom requis').max(80),
    type: mediaTypeSchema,
    serverId: z.number().int().positive(),
    ...conditionFields,
    qualityProfileId: profileId.nullable().default(null),
    rootFolderPath: rootFolderPath.nullable().default(null),
    seriesType: z.enum(seriesTypes).nullable().default(null),
    /** Ids d'étiquettes du serveur, ajoutées à celles du serveur et du membre. */
    tags: z.array(z.number().int().nonnegative()).max(CONDITION_MAX).default([]),
    enabled: z.boolean().default(true),
  })
  .refine((rule) => rule.genres.length + rule.languages.length + rule.keywords.length > 0, {
    message: 'Au moins une condition (genre, langue ou mot-clé)',
    path: ['genres'],
  })
  .refine((rule) => rule.type === 'tv' || rule.seriesType === null, {
    message: 'Un film n’a pas de type de série',
    path: ['seriesType'],
  });
export type OverrideRuleInput = z.input<typeof overrideRuleInputSchema>;
export type OverrideRuleValues = z.output<typeof overrideRuleInputSchema>;

export interface OverrideRule extends OverrideRuleValues {
  id: number;
  /** Rang dans la liste : la première règle qui correspond l'emporte. */
  position: number;
}

export const overrideRuleIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const overrideRulesOrderSchema = z.object({ ids: z.array(z.number().int().positive()).max(500) });

/** Ce qu'une règle lit du titre (fiche TMDB déjà chargée à l'approbation). */
export interface OverrideTitle {
  genres: readonly number[];
  originalLanguage: string | null;
  keywords: readonly number[];
}

export const overrideTitleOf = (
  details: Pick<MediaDetails, 'genres' | 'keywords' | 'originalLanguage'>,
): OverrideTitle => ({
  genres: details.genres.map((g) => g.id),
  originalLanguage: details.originalLanguage ?? null,
  keywords: (details.keywords ?? []).map((k) => k.id),
});

/**
 * La règle vaut-elle pour ce titre ? Chaque liste non vide doit être satisfaite (ET entre genres, langues et mots-clés),
 * par l'une de ses valeurs (OU dans une liste).
 */
export function ruleMatches(
  rule: Pick<OverrideRuleValues, 'genres' | 'languages' | 'keywords'>,
  title: OverrideTitle,
): boolean {
  const any = <T>(wanted: readonly T[], has: (value: T) => boolean) => wanted.length === 0 || wanted.some(has);
  return (
    any(rule.genres, (id) => title.genres.includes(id)) &&
    any(rule.languages, (code) => code === title.originalLanguage) &&
    any(rule.keywords, ({ id }) => title.keywords.includes(id))
  );
}

/** Niveau de `resolveSendChoice` d'une règle : ses effets ne valent que si son serveur est retenu. */
export const ruleLayer = (rule: OverrideRule): SendChoiceLayer => ({
  serverId: rule.serverId,
  qualityProfileId: rule.qualityProfileId,
  rootFolderPath: rule.rootFolderPath,
  seriesType: rule.seriesType,
});

/** Règles (déjà retenues pour le titre) qui jouent sur le serveur d'envoi, dans l'ordre. */
export const rulesOnServer = <R extends Pick<OverrideRule, 'serverId'>>(rules: readonly R[], serverId: number) =>
  rules.filter((rule) => rule.serverId === serverId);

/** Règle qui a joué, montrée à l'approbation. */
export type AppliedRule = Pick<OverrideRule, 'id' | 'name'>;
