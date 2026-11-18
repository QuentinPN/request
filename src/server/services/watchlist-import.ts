import { eq } from 'drizzle-orm';
import { keyOf, type MediaSummary, type MediaType } from '../../shared/media.ts';
import {
  type ImportSource,
  LETTERBOXD_MAX_ROWS,
  type SkippedTitle,
  type WatchlistImportResult,
} from '../../shared/watchlist.ts';
import type { Data } from '../db/index.ts';
import { watchlist } from '../db/schema.ts';
import { IntegrationError } from '../integrations/http.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { fetchTraktWatchlist, testTrakt } from '../integrations/trakt.ts';
import { HttpError } from '../lib/api-errors.ts';
import { parseCsvRecords } from '../lib/csv.ts';
import { getSetting } from './settings.ts';

/** Titre prêt à entrer dans la liste (copie d'affichage comprise). */
interface Candidate {
  type: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

/** Recherches TMDB simultanées d'un import Letterboxd. */
const SEARCH_CONCURRENCY = 8;

// --- Letterboxd : lecture du fichier et correspondance TMDB ---

export interface LetterboxdRow {
  title: string;
  year: number | null;
}

/**
 * Lit `watchlist.csv` (colonnes `Date,Name,Year,Letterboxd URI`, dans l'ordre qu'on veut) ; lignes sans titre écartées.
 * Un fichier sans colonne `Name` n'est pas une liste Letterboxd : 422.
 */
export function parseLetterboxdWatchlist(csv: string): LetterboxdRow[] {
  const records = parseCsvRecords(csv);
  if (!records.some((record) => 'name' in record))
    throw new HttpError(422, 'Fichier non reconnu : envoyez le watchlist.csv de l’export Letterboxd.');
  return records.flatMap((record) => {
    const title = record.name ?? '';
    const year = Number.parseInt(record.year ?? '', 10);
    return title === '' ? [] : [{ title, year: year > 0 ? year : null }];
  });
}

/** Titre comparable : sans accents, majuscules ni ponctuation (« Amélie », « amelie ! » se valent). */
export const normalizeTitle = (title: string) =>
  title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

type Found = MediaSummary & { originalTitle: string };

/**
 * Correspondance d'une ligne Letterboxd avec les films trouvés par TMDB (dans son ordre). Un film correspond si son
 * titre, français ou original, est le même et l'année identique (à un an près, faute d'exacte). Un seul film :
 * trouvé ; plusieurs, ou des résultats sans correspondance sûre : `ambiguous` ; aucun résultat : `not_found`.
 */
export function matchMovie(row: LetterboxdRow, results: readonly Found[]): Found | 'ambiguous' | 'not_found' {
  if (results.length === 0) return 'not_found';
  const wanted = normalizeTitle(row.title);
  const sameTitle = results.filter(
    (r) => normalizeTitle(r.title) === wanted || normalizeTitle(r.originalTitle) === wanted,
  );
  const withGap = (max: number) =>
    row.year === null
      ? sameTitle
      : sameTitle.filter((r) => r.year !== null && Math.abs(r.year - (row.year ?? 0)) <= max);
  const pool = withGap(0).length > 0 ? withGap(0) : withGap(1);
  return pool.length === 1 && pool[0] ? pool[0] : 'ambiguous';
}

/** Applique `fn` à chaque élément, `size` à la fois ; l'ordre des résultats est celui des éléments. */
async function mapInBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// --- Écriture ---

/**
 * Aperçu ou import des candidats dans la liste du membre : doublons de la source et titres déjà dans la liste
 * comptés à part, le reste ajouté en une seule écriture (`onConflictDoNothing` : relancer ne duplique rien).
 */
function store(
  { db }: Data,
  userId: string,
  source: ImportSource,
  {
    dryRun,
    total,
    truncated = false,
    candidates,
    skipped,
  }: { dryRun: boolean; total: number; truncated?: boolean; candidates: Candidate[]; skipped: SkippedTitle[] },
): WatchlistImportResult {
  const unique = [...new Map(candidates.map((c) => [keyOf({ type: c.type, tmdbId: c.tmdbId }), c])).values()];
  const existing = new Set(
    db
      .select({ type: watchlist.mediaType, tmdbId: watchlist.tmdbId })
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .all()
      .map(keyOf),
  );
  const fresh = unique.filter((c) => !existing.has(keyOf({ type: c.type, tmdbId: c.tmdbId })));
  let imported = fresh.length;
  if (!dryRun && fresh.length > 0)
    imported = db
      .insert(watchlist)
      .values(
        fresh.map((c) => ({
          userId,
          mediaType: c.type,
          tmdbId: c.tmdbId,
          title: c.title,
          year: c.year,
          posterPath: c.posterPath,
          source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: watchlist.id })
      .all().length;
  return { dryRun, source, total, truncated, imported, alreadyInList: unique.length - fresh.length, skipped };
}

// --- Imports ---

/** Message d'un profil Trakt illisible : profil privé (ou introuvable), ou Client ID refusé par Trakt. */
const PRIVATE_PROFILE =
  'Cette liste est introuvable ou privée. Vérifiez le nom d’utilisateur, et que la liste de souhaits est publique (Trakt › Paramètres › Confidentialité).';

export function createWatchlistImport(data: Data, deps: { tmdb: () => TmdbClient; traktUrl?: string }) {
  const traktConfig = () => {
    const stored = getSetting(data.db, data.cryptoKey, 'trakt');
    if (!stored)
      throw new HttpError(
        409,
        'L’import Trakt n’est pas activé : le propriétaire doit d’abord renseigner le Client ID Trakt dans Réglages.',
      );
    return { ...stored, ...(deps.traktUrl && { baseUrl: deps.traktUrl }) };
  };

  /** Un 401/403 de Trakt : clé refusée ou profil privé ? Une lecture publique avec la même clé les départage. */
  async function explain(error: unknown, config: ReturnType<typeof traktConfig>): Promise<unknown> {
    if (!(error instanceof IntegrationError)) return error;
    if (error.kind === 'not_found') return new HttpError(422, PRIVATE_PROFILE);
    if (error.kind !== 'unauthorized') return error;
    try {
      await testTrakt(config);
      return new HttpError(422, PRIVATE_PROFILE);
    } catch (probe) {
      if (probe instanceof IntegrationError && probe.kind === 'unauthorized')
        return new HttpError(
          422,
          'Trakt refuse le Client ID enregistré : le propriétaire doit le vérifier dans Réglages.',
        );
      return probe;
    }
  }

  /** Liste de souhaits publique d'un utilisateur Trakt : l'id TMDB vient de Trakt, un titre sans id est écarté. */
  async function importTrakt(userId: string, username: string, dryRun: boolean): Promise<WatchlistImportResult> {
    const config = traktConfig();
    const { titles, truncated } = await fetchTraktWatchlist(config, username).catch(async (error) => {
      throw await explain(error, config);
    });
    const candidates: Candidate[] = [];
    const skipped: SkippedTitle[] = [];
    for (const { type, tmdbId, title, year } of titles) {
      if (tmdbId === null) skipped.push({ title, year, reason: 'no_tmdb_id' });
      else candidates.push({ type, tmdbId, title, year, posterPath: null });
    }
    return store(data, userId, 'trakt', { dryRun, total: titles.length, truncated, candidates, skipped });
  }

  /** `watchlist.csv` de Letterboxd : chaque film est cherché chez TMDB (titre, année), sans plus de 1 000 lignes. */
  async function importLetterboxd(userId: string, csv: string, dryRun: boolean): Promise<WatchlistImportResult> {
    const rows = parseLetterboxdWatchlist(csv);
    if (rows.length > LETTERBOXD_MAX_ROWS)
      throw new HttpError(422, `Liste trop longue : ${LETTERBOXD_MAX_ROWS} titres au plus par import.`);
    const tmdb = deps.tmdb();
    const matches = await mapInBatches(rows, SEARCH_CONCURRENCY, async (row) => ({
      row,
      match: matchMovie(row, await tmdb.searchMovies(row.title)),
    }));
    const candidates: Candidate[] = [];
    const skipped: SkippedTitle[] = [];
    for (const { row, match } of matches) {
      if (typeof match === 'string') skipped.push({ ...row, reason: match });
      else
        candidates.push({
          type: 'movie',
          tmdbId: match.tmdbId,
          title: match.title,
          year: match.year,
          posterPath: match.posterPath,
        });
    }
    return store(data, userId, 'letterboxd', { dryRun, total: rows.length, candidates, skipped });
  }

  // Un seul import à la fois par membre (aperçu compris) ; le verrou est libéré quoi qu'il arrive.
  const running = new Set<string>();
  const exclusive =
    <A extends unknown[]>(run: (userId: string, ...args: A) => Promise<WatchlistImportResult>) =>
    async (userId: string, ...args: A) => {
      if (running.has(userId)) throw new HttpError(409, 'Un import est déjà en cours');
      running.add(userId);
      try {
        return await run(userId, ...args);
      } finally {
        running.delete(userId);
      }
    };

  return { importTrakt: exclusive(importTrakt), importLetterboxd: exclusive(importLetterboxd) };
}
