import { z } from 'zod';
import { mediaSummarySchema, mediaTypeSchema, pagedSchema } from './media.ts';

/** Origine d'un titre de la liste de souhaits : ajouté dans l'appli, ou importé d'une liste Trakt ou Letterboxd. */
export const watchlistSources = ['manual', 'trakt', 'letterboxd'] as const;
export type WatchlistSource = (typeof watchlistSources)[number];
export const watchlistSourceSchema = z.enum(watchlistSources);

/**
 * Titre de la liste d'un membre (unique par membre et titre). Titre, année et affiche sont une copie pour l'affichage
 * (facultatifs) : TMDB reste la source.
 */
export const watchlistItemSchema = z.object({
  mediaType: mediaTypeSchema,
  tmdbId: z.number().int().positive(),
  title: z.string().nullable(),
  year: z.number().int().nullable(),
  posterPath: z.string().nullable(),
  source: watchlistSourceSchema,
  /** ISO 8601. */
  addedAt: z.string(),
});
export type WatchlistItem = z.output<typeof watchlistItemSchema>;

// --- API de la liste de souhaits (chaque membre ne voit et ne modifie que la sienne) ---

export const WATCHLIST_PATH = '/api/watchlist';
export const WATCHLIST_ITEM_ROUTE = `${WATCHLIST_PATH}/:type/:id`;
export const watchlistItemPath = (type: string, id: number) => `${WATCHLIST_PATH}/${type}/${id}`;
export const WATCHLIST_IMPORT_PATH = `${WATCHLIST_PATH}/import`;
/** Réglage Trakt (propriétaire seulement) : lecture et enregistrement du `client_id`. */
export const TRAKT_SETTINGS_PATH = '/api/settings/trakt';

/** Titres par page de « Ma liste ». */
export const WATCHLIST_PAGE_SIZE = 40;

/** Ajout : le serveur lit le titre chez TMDB (il valide l'id et garde titre, année et affiche). */
export const addWatchlistSchema = z.object({ type: mediaTypeSchema, tmdbId: z.number().int().positive() });
export type AddWatchlistInput = z.input<typeof addWatchlistSchema>;

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
