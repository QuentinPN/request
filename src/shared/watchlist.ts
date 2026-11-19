import { z } from 'zod';
import { mediaSummarySchema, mediaTypeSchema, pagedSchema } from './media.ts';
import { settingsPathOf } from './settings-path.ts';

/** Origine d'un titre de la liste de souhaits : ajouté dans l'appli, ou importé d'une liste Trakt ou Letterboxd. */
export const watchlistSources = ['manual', 'trakt', 'letterboxd'] as const;
export type WatchlistSource = (typeof watchlistSources)[number];
export const watchlistSourceSchema = z.enum(watchlistSources);

// --- API de la liste de souhaits (chaque membre ne voit et ne modifie que la sienne) ---

export const WATCHLIST_PATH = '/api/watchlist';
export const WATCHLIST_ITEM_ROUTE = `${WATCHLIST_PATH}/:type/:id`;
export const watchlistItemPath = (type: string, id: number) => `${WATCHLIST_PATH}/${type}/${id}`;
export const WATCHLIST_IMPORT_PATH = `${WATCHLIST_PATH}/import`;
/** Réglage Trakt (propriétaire seulement) : lecture et enregistrement du `client_id`. */
export const TRAKT_SETTINGS_PATH = settingsPathOf('trakt');

/** Titres par page de « Ma liste ». */
export const WATCHLIST_PAGE_SIZE = 40;

/** Ajout : le serveur lit le titre chez TMDB (il valide l'id et garde titre, année et affiche). */
export const addWatchlistSchema = z.object({ type: mediaTypeSchema, tmdbId: z.number().int().positive() });

/** Titre de « Ma liste » : un résumé TMDB (donc affichable comme toute affiche, avec son statut) et son origine. */
export const watchlistEntrySchema = mediaSummarySchema.extend({
  source: watchlistSourceSchema,
  addedAt: z.string(),
});
export type WatchlistEntry = z.output<typeof watchlistEntrySchema>;

export const watchlistPageSchema = pagedSchema(watchlistEntrySchema).extend({ total: z.number().int() });
export type WatchlistPage = z.output<typeof watchlistPageSchema>;

/** Le titre est-il dans la liste du membre (bouton de la fiche). */
export const inWatchlistSchema = z.object({ inList: z.boolean() });
export type InWatchlist = z.output<typeof inWatchlistSchema>;

// --- Demande automatique à l'ajout (droit « Demander automatiquement depuis Ma liste ») ---

export const WATCHLIST_AUTO_REQUEST_PATH = `${WATCHLIST_PATH}/auto-request`;

/** Option du membre : demander aussi chaque titre qu'il ajoute à sa liste (droit `canAutoRequestWatchlist` requis). */
export const autoRequestSettingSchema = z.object({ enabled: z.boolean() });
export type AutoRequestSetting = z.output<typeof autoRequestSettingSchema>;

/** Sort de la demande lancée par un ajout : faite, ou sautée (l'ajout à la liste, lui, a toujours réussi) avec son motif. */
export const autoRequestOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('requested') }),
  z.object({ status: z.literal('skipped'), reason: z.string() }),
]);
export type AutoRequestOutcome = z.output<typeof autoRequestOutcomeSchema>;

/** Réponse de l'ajout : `autoRequest` n'est présent que si l'option du membre était active. */
export const addedToWatchlistSchema = inWatchlistSchema.extend({ autoRequest: autoRequestOutcomeSchema.optional() });
export type AddedToWatchlist = z.output<typeof addedToWatchlistSchema>;

/** Message discret après un ajout (« Ajouté à Ma liste et demandé »), `null` quand rien n'est à dire. */
export function addedMessage(outcome: AutoRequestOutcome | undefined): string | null {
  if (!outcome) return null;
  if (outcome.status === 'requested') return 'Ajouté à Ma liste et demandé.';
  const reason = /^[A-ZÀ-Ý][a-zà-ÿ]/.test(outcome.reason)
    ? outcome.reason.charAt(0).toLowerCase() + outcome.reason.slice(1)
    : outcome.reason;
  return `Ajouté à Ma liste ; pas demandé : ${reason}`;
}

// --- Import Trakt et Letterboxd ---

export const importSources = ['trakt', 'letterboxd'] as const satisfies readonly WatchlistSource[];
export type ImportSource = (typeof importSources)[number];
export const importPath = (source: ImportSource) => `${WATCHLIST_IMPORT_PATH}/${source}`;

export const importQuerySchema = z.object({ dryRun: z.stringbool().default(false) });

/** Nom d'utilisateur Trakt (« slug ») : lettres, chiffres, tirets et soulignés, sans plus (il entre dans une adresse). */
export const traktUsernameSchema = z
  .string()
  .trim()
  .regex(/^[\w-]{1,50}$/, 'Nom d’utilisateur Trakt invalide');
export const traktImportSchema = z.object({ username: traktUsernameSchema });
export type TraktImportInput = z.input<typeof traktImportSchema>;

/** `watchlist.csv` de l'export Letterboxd, envoyé en texte : taille et nombre de titres bornés. */
export const LETTERBOXD_MAX_BYTES = 512 * 1024;
export const LETTERBOXD_MAX_ROWS = 1000;
export const letterboxdImportSchema = z.object({ csv: z.string().min(1, 'Fichier vide').max(LETTERBOXD_MAX_BYTES) });
export type LetterboxdImportInput = z.input<typeof letterboxdImportSchema>;

/** Pourquoi un titre de la liste source n'est pas importé. */
export const skipReasons = ['no_tmdb_id', 'not_found', 'ambiguous'] as const;
export const skipReasonSchema = z.enum(skipReasons);
export type SkipReason = z.infer<typeof skipReasonSchema>;
export const skipReasonLabels: Record<SkipReason, string> = {
  no_tmdb_id: 'Pas d’identifiant TMDB',
  not_found: 'Introuvable sur TMDB',
  ambiguous: 'Correspondance incertaine',
};

export const skippedTitleSchema = z.object({
  title: z.string(),
  year: z.number().int().nullable(),
  reason: skipReasonSchema,
});
export type SkippedTitle = z.output<typeof skippedTitleSchema>;

/** Bilan d'un import, ou de son aperçu (`dryRun`) : mêmes règles, mêmes comptes. */
export const watchlistImportResultSchema = z.object({
  dryRun: z.boolean(),
  source: z.enum(importSources),
  /** Titres lus dans la liste source. */
  total: z.number().int(),
  /** La liste source dépasse la limite lue (Trakt : 2 000 titres) : seuls les premiers sont pris en compte. */
  truncated: z.boolean(),
  /** Ajoutés à la liste (ou à ajouter, en aperçu). */
  imported: z.number().int(),
  /** Déjà dans la liste du membre. */
  alreadyInList: z.number().int(),
  skipped: z.array(skippedTitleSchema),
});
export type WatchlistImportResult = z.output<typeof watchlistImportResultSchema>;
