import { desc, eq } from 'drizzle-orm';
import type { BlockedKeyword, Blocklist, BlockTitleInput } from '../../shared/blocklist.ts';
import { keyOf, type MediaBlock, type MediaDetails, type MediaKey, type MediaSummary } from '../../shared/media.ts';
import type { Data, Db } from '../db/index.ts';
import { blockedTitles, users } from '../db/schema.ts';
import type { TmdbClient } from '../integrations/tmdb.ts';
import { HttpError } from '../lib/api-errors.ts';
import { keyPairsIn } from '../lib/sql.ts';
import type { SessionViewer } from '../plugins/auth.ts';
import { getSetting, setSetting } from './settings.ts';
import { orTitleNotFound } from './tmdb.ts';

/**
 * Blocages (lot 7.9). Un titre bloqué (`blocked_titles`) ou portant un mot-clé bloqué (réglage `blockedKeywords`) ne se
 * demande plus, par personne : le serveur refuse (403). Les membres ne voient plus les titres bloqués dans Découvrir ni
 * dans la recherche ; qui gère les blocages les voit, marqués, pour pouvoir les débloquer. Les mots-clés ne sont connus
 * que de la fiche (`append_to_response=keywords`) et des flux `/discover` (`without_keywords`) : tendances, populaires,
 * prochainement et recherche ne sont pas filtrés par mot-clé, seule la fiche (et le refus de la demande) bloque. Les
 * demandes déjà faites ne sont pas touchées : celles en attente restent à approuver ou refuser.
 */

/** Clés `type:tmdbId` des titres bloqués parmi `keys`, en une requête (index unique `(media_type, tmdb_id)`). */
export function blockedKeysIn(db: Pick<Db, 'select'>, keys: readonly MediaKey[]): Set<string> {
  if (keys.length === 0) return new Set();
  const rows = db
    .select({ type: blockedTitles.mediaType, tmdbId: blockedTitles.tmdbId })
    .from(blockedTitles)
    .where(keyPairsIn(blockedTitles.mediaType, blockedTitles.tmdbId, keys))
    .all();
  return new Set(rows.map(keyOf));
}

/** Mots-clés TMDB bloqués (liste courte, lue en entier). */
export const blockedKeywords = ({ db, cryptoKey }: Data): BlockedKeyword[] =>
  getSetting(db, cryptoKey, 'blockedKeywords')?.keywords ?? [];

/** Ids des mots-clés bloqués, pour `without_keywords` ; vide pour qui gère les blocages (il voit tout). */
export const excludedKeywordIds = (data: Data, viewer: SessionViewer): number[] =>
  viewer.capabilities.canManageBlocklist ? [] : blockedKeywords(data).map((k) => k.id);

/** Blocage d'une fiche : le titre lui-même d'abord, puis le premier de ses mots-clés bloqué. */
export function blockOf(data: Data, details: MediaDetails): MediaBlock | undefined {
  if (blockedKeysIn(data.db, [details]).size > 0) return { by: 'title' };
  const blocked = new Map(blockedKeywords(data).map((k) => [k.id, k.name]));
  const keyword = details.keywords?.find((k) => blocked.has(k.id));
  return keyword ? { by: 'keyword', keyword: blocked.get(keyword.id) ?? keyword.name } : undefined;
}

/** Message du refus d'une demande. */
export const blockedMessage = (block: MediaBlock) =>
  block.by === 'title'
    ? 'Ce titre est bloqué : il ne peut pas être demandé'
    : `Ce titre est bloqué (mot-clé « ${block.keyword} ») : il ne peut pas être demandé`;

/** Refuse (403) un titre de la liste des titres bloqués, avant tout appel à TMDB. */
export function assertTitleNotBlocked(db: Pick<Db, 'select'>, key: MediaKey) {
  if (blockedKeysIn(db, [key]).size > 0) throw new HttpError(403, blockedMessage({ by: 'title' }));
}

/** Refuse (403) une fiche bloquée, par son titre ou un de ses mots-clés. */
export function assertNotBlocked(data: Data, details: MediaDetails) {
  const block = blockOf(data, details);
  if (block) throw new HttpError(403, blockedMessage(block));
}

/**
 * Titres d'une liste (Découvrir, recherche) vus par `viewer` : sans les titres bloqués pour un membre, marqués
 * (`blocked`) pour qui gère les blocages. Toujours des copies pour les titres marqués (objets partagés par le cache).
 */
export function forViewer<T extends MediaSummary>(db: Pick<Db, 'select'>, viewer: SessionViewer, items: T[]): T[] {
  const blocked = blockedKeysIn(db, items);
  if (blocked.size === 0) return items;
  if (!viewer.capabilities.canManageBlocklist) return items.filter((item) => !blocked.has(keyOf(item)));
  return items.map((item) => (blocked.has(keyOf(item)) ? { ...item, blocked: { by: 'title' } } : item));
}

/** Liste, blocage et déblocage des titres, mots-clés (droit « Gérer les blocages »). */
export function createBlocklist(data: Data, deps: { tmdb: () => TmdbClient; now?: () => number }) {
  const { db, cryptoKey } = data;
  const now = deps.now ?? Date.now;

  function list(): Blocklist {
    const titles = db
      .select({ row: blockedTitles, by: users.name })
      .from(blockedTitles)
      .leftJoin(users, eq(users.id, blockedTitles.blockedBy))
      .orderBy(desc(blockedTitles.createdAt), desc(blockedTitles.id))
      .all()
      .map(({ row, by }) => ({
        mediaType: row.mediaType,
        tmdbId: row.tmdbId,
        title: row.title,
        blockedBy: by,
        createdAt: row.createdAt.toISOString(),
      }));
    return { titles, keywords: blockedKeywords(data) };
  }

  /** Bloque un titre (idempotent) ; son nom vient de TMDB, jamais du navigateur. Titre inconnu de TMDB → 404. */
  async function block(actorId: string, { mediaType, tmdbId }: BlockTitleInput): Promise<Blocklist> {
    const { title } = await orTitleNotFound(() => deps.tmdb().summary(mediaType, tmdbId));
    db.insert(blockedTitles)
      .values({ mediaType, tmdbId, title, blockedBy: actorId, createdAt: new Date(now()) })
      .onConflictDoNothing()
      .run();
    return list();
  }

  function unblock(key: MediaKey): Blocklist {
    db.delete(blockedTitles)
      .where(keyPairsIn(blockedTitles.mediaType, blockedTitles.tmdbId, [key]))
      .run();
    return list();
  }

  /** Remplace la liste des mots-clés bloqués (doublons retirés, ordre gardé). */
  function setKeywords(keywords: BlockedKeyword[]): Blocklist {
    const unique = [...new Map(keywords.map((k) => [k.id, k])).values()];
    setSetting(db, cryptoKey, 'blockedKeywords', { keywords: unique });
    return list();
  }

  /** Mots-clés TMDB par nom ; ceux sans nom (rares) sont écartés, ils ne pourraient pas être affichés. */
  const searchKeywords = async (query: string): Promise<BlockedKeyword[]> =>
    (await deps.tmdb().searchKeywords(query)).filter((k) => k.id > 0 && k.name.trim() !== '');

  return { list, block, unblock, setKeywords, searchKeywords };
}
