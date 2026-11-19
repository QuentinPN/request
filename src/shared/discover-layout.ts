import { z } from 'zod';
import { savedFiltersSchema } from './catalogue.ts';
import { mediaTypeSchema } from './media.ts';

/**
 * Rangées de Découvrir fournies par l'appli, dans l'ordre par défaut de la page. Les trois dernières sont des rangées
 * à logos (plateformes, studios, chaînes), que le navigateur construit ; `emby-recent` garde son identifiant quel que
 * soit le serveur multimédia (contrat de l'API).
 */
export const builtInRowIds = [
  'trending',
  'recent-requests',
  'popular-movies',
  'popular-tv',
  'upcoming',
  'emby-recent',
  'providers',
  'studios',
  'networks',
] as const;
export type BuiltInRowId = (typeof builtInRowIds)[number];

/** Titre de chaque rangée de l'appli ; « Ajoutés récemment » reçoit sur la page le nom du serveur multimédia. */
export const builtInRowTitles: Record<BuiltInRowId, string> = {
  trending: 'Tendances',
  'recent-requests': 'Demandes récentes',
  'popular-movies': 'Films populaires',
  'popular-tv': 'Séries populaires',
  upcoming: 'Prochainement',
  'emby-recent': 'Ajoutés récemment',
  providers: 'Par plateforme',
  studios: 'Par studio',
  networks: 'Par chaîne',
};

/** Rangées à logos : sans élément à charger côté serveur, elles ne figurent que dans `layout` de la réponse. */
export const logoRowIds = ['providers', 'studios', 'networks'] as const satisfies readonly BuiltInRowId[];
export type LogoRowId = (typeof logoRowIds)[number];
export const isLogoRow = (id: string): id is LogoRowId => (logoRowIds as readonly string[]).includes(id);

/** Chaque rangée sur mesure coûte un appel à TMDB à chaque affichage de Découvrir : on les limite. */
export const CUSTOM_ROW_LIMIT = 20;
export const CUSTOM_ROW_TITLE_MAX = 60;

export const builtInRowSchema = z.object({
  kind: z.literal('builtin'),
  id: z.enum(builtInRowIds),
  enabled: z.boolean(),
});

/** Rangée sur mesure : un titre et un filtre de Films ou Séries (`type` + mêmes paramètres que les pages). */
export const customRowSchema = z.object({
  kind: z.literal('custom'),
  id: z.string().regex(/^custom-[a-z0-9]{4,24}$/),
  title: z.string().trim().min(1, 'Titre requis').max(CUSTOM_ROW_TITLE_MAX),
  type: mediaTypeSchema,
  filters: savedFiltersSchema,
  enabled: z.boolean(),
});

export const layoutRowSchema = z.discriminatedUnion('kind', [builtInRowSchema, customRowSchema]);
export type LayoutRow = z.output<typeof layoutRowSchema>;
export type CustomRow = z.output<typeof customRowSchema>;

/** Rangées de l'appli dans l'ordre par défaut, toutes actives. */
export const defaultBuiltInRows = (): LayoutRow[] =>
  builtInRowIds.map((id) => ({ kind: 'builtin' as const, id, enabled: true }));

/**
 * Liste complète : un doublon est ignoré et chaque rangée de l'appli absente de l'ordre enregistré (réglage jamais
 * enregistré, ou rangée ajoutée depuis par une mise à jour) est ajoutée à la fin, active.
 */
export function resolveLayout(rows: readonly LayoutRow[]): LayoutRow[] {
  const seen = new Set<string>();
  const resolved = rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
  return [...resolved, ...defaultBuiltInRows().filter((row) => !seen.has(row.id))];
}

/**
 * Écriture du réglage `discoverLayout` : ordre et état de toutes les rangées. Rien d'enregistré (`rows` vide) = ordre
 * par défaut. Validé à l'écriture (identifiants uniques, nombre de rangées sur mesure), complété à chaque lecture
 * (`resolveLayout`). Une rangée de l'appli inconnue est refusée.
 */
export const discoverLayoutInputSchema = z.object({
  rows: z
    .array(layoutRowSchema)
    .max(builtInRowIds.length + CUSTOM_ROW_LIMIT)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, 'Rangées en double')
    .refine((rows) => rows.filter((row) => row.kind === 'custom').length <= CUSTOM_ROW_LIMIT, {
      message: `Au plus ${CUSTOM_ROW_LIMIT} rangées sur mesure`,
    })
    .transform(resolveLayout)
    .prefault([]),
});

const isKnownRow = (row: unknown) =>
  !(row && typeof row === 'object' && 'kind' in row && row.kind === 'builtin' && 'id' in row) ||
  (builtInRowIds as readonly unknown[]).includes(row.id);

/** Lecture du réglage enregistré : une rangée de l'appli retirée depuis par une mise à jour est ignorée, pas une erreur. */
export const discoverLayoutSchema = z.preprocess(
  (value) =>
    value && typeof value === 'object' && 'rows' in value && Array.isArray(value.rows)
      ? { ...value, rows: value.rows.filter(isKnownRow) }
      : value,
  discoverLayoutInputSchema,
);
