import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  type BrowseFilters,
  browsePath,
  browseQuerySchema,
  collectionPath,
  DISCOVER_PATH,
  discoverListPath,
  discoverRowSchema,
  genresPath,
  genresResponseSchema,
  idParamsSchema,
  mediaPath,
  pagedMediaSchema,
  pageQuerySchema,
  personPath,
  providersPath,
  providersResponseSchema,
  SEARCH_PATH,
  searchQuerySchema,
  typeIdParamsSchema,
  typeParamsSchema,
} from '../../shared/catalogue.ts';
import { type BuiltInRowId, builtInRowTitles, isLogoRow, type LogoRowId } from '../../shared/discover-layout.ts';
import {
  collectionDetailsSchema,
  keyOf,
  type MediaSummary,
  type MediaType,
  mediaSearchResultsSchema,
  personDetailsSchema,
} from '../../shared/media.ts';
import { labelOf } from '../integrations/media-server.ts';
import { parseRequest, parseUpstream } from '../lib/api-errors.ts';
import { viewerOf } from '../plugins/auth.ts';
import { withStatus } from '../services/availability.ts';
import { blockOf, excludedKeywordIds, forViewer } from '../services/blocklist.ts';
import { discoverLayoutOf, hiddenInDiscover, recentRequestKeys } from '../services/discover.ts';
import { loadDetails, loadSummaries, orTitleNotFound } from '../services/tmdb.ts';

const SERVICE = 'TMDB';
/** Rangée de titres déjà dans la bibliothèque : « Masquer les disponibles » la viderait, elle n'y est pas soumise. */
const LIBRARY_ROW = 'emby-recent';
/** Rangées de l'appli chargées par le serveur (les rangées à logos sont construites par le navigateur). */
type DataRowId = Exclude<BuiltInRowId, LogoRowId>;

/** API du catalogue TMDB : rangées Découvrir, genres, plateformes, recherche et fiches, avec le statut de chaque titre. */
export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get(DISCOVER_PATH, async (req) => {
    const tmdb = app.tmdb();
    const viewer = viewerOf(req);
    const { id: userId } = viewer.user;
    // Ordre de PRODUCT.md ; « Ajoutés récemment dans … » (nom du serveur multimédia) est omise tant qu'aucun n'est
    // configuré (`null`). Son id `emby-recent` reste celui du contrat, quel que soit le serveur.
    const server = app.mediaServers.current();
    // Résumés TMDB des titres demandés, dans l'ordre des demandes ; aucune demande (ou aucun résumé) : rangée omise.
    const recentRequests = async () => {
      const keys = recentRequestKeys(app.data.db);
      const found = await loadSummaries(app.tmdb, keys);
      const items = keys.flatMap((key) => found.get(keyOf(key)) ?? []);
      return items.length > 0 ? items : null;
    };
    type Row = {
      id: string;
      title: string;
      load: () => Promise<MediaSummary[] | null>;
      seeAll?: { type: MediaType; filters: BrowseFilters };
    };
    const builtIn: Record<DataRowId, Omit<Row, 'id'>> = {
      trending: { title: builtInRowTitles.trending, load: () => tmdb.trendingAll('week') },
      'recent-requests': { title: builtInRowTitles['recent-requests'], load: recentRequests },
      'popular-movies': { title: builtInRowTitles['popular-movies'], load: () => tmdb.popular('movie') },
      'popular-tv': { title: builtInRowTitles['popular-tv'], load: () => tmdb.popular('tv') },
      upcoming: { title: builtInRowTitles.upcoming, load: () => tmdb.upcoming() },
      'emby-recent': {
        title: `${builtInRowTitles['emby-recent']} dans ${server ? labelOf(server) : 'la bibliothèque'}`,
        load: () => app.availability.recentlyAdded(userId),
      },
    };
    // Ordre et rangées actives choisis par le propriétaire : une rangée désactivée n'appelle pas TMDB. Les rangées à
    // logos n'ont rien à charger ici (le navigateur les construit) : elles ne figurent que dans `layout`.
    const active = discoverLayoutOf(app.data).rows.filter((row) => row.enabled);
    const rows = active.flatMap((row): Row[] => {
      if (row.kind === 'custom') {
        const { type, filters } = row;
        return [
          {
            id: row.id,
            title: row.title,
            load: async () => (await tmdb.browse(type, filters, 1, excludedKeywordIds(app.data, viewer))).results,
            seeAll: { type, filters },
          },
        ];
      }
      return isLogoRow(row.id) ? [] : [{ id: row.id, ...builtIn[row.id] }];
    });
    const settled = await Promise.allSettled(
      rows.map(async ({ id, title, load, seeAll }) => {
        const items = await load();
        return items && parseUpstream(SERVICE, discoverRowSchema, { id, title, items, seeAll });
      }),
    );
    // Une rangée en échec (ou hors contrat) est omise ; si aucune ne reste, l'erreur remonte (une page vide cacherait la panne).
    const fetched = settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed && fetched.length === 0) throw failed.reason;
    // Titres bloqués retirés (membres) ou marqués (gestionnaires), puis statuts de toutes les rangées en un seul lot.
    const loaded = fetched.map((row) => ({ ...row, items: forViewer(app.data.db, viewer, row.items) }));
    const statuses = await app.availability.statusesFor(loaded.flatMap((row) => row.items));
    // « Masquer dans Découvrir » (disponibles, déjà demandés) ; une rangée vidée par ces filtres est omise.
    const hidden = hiddenInDiscover(
      app.data,
      loaded.filter((row) => row.id !== LIBRARY_ROW).flatMap((row) => row.items),
      statuses,
    );
    return {
      rows: loaded.flatMap((row, i) => {
        const items = row.items.filter((item) => !hidden.has(keyOf(item)));
        return items.length === 0 && fetched[i]?.items.length
          ? []
          : [{ ...row, items: items.map((item) => withStatus(statuses, item)) }];
      }),
      layout: active.map((row) => row.id),
    };
  });

  /** Liste « Charger plus » : flux TMDB `/discover` (mots-clés bloqués écartés par TMDB pour les membres), blocages et statuts. */
  const discoverList = async (req: FastifyRequest, load: (exclude: number[]) => Promise<unknown>) => {
    const viewer = viewerOf(req);
    const paged = parseUpstream(SERVICE, pagedMediaSchema, await load(excludedKeywordIds(app.data, viewer)));
    const results = forViewer(app.data.db, viewer, paged.results);
    return { ...paged, results: await app.availability.withStatuses(results) };
  };

  app.get(discoverListPath(':type', ':id'), async (req) => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    const { page } = parseRequest(pageQuerySchema, req.query);
    return discoverList(req, (exclude) => app.tmdb().discoverByProvider(type, id, page, exclude));
  });

  // Films et Séries : filtres validés (400 si invalides) puis traduits en paramètres TMDB.
  app.get(browsePath(':type'), async (req) => {
    const { type } = parseRequest(typeParamsSchema, req.params);
    const { page, ...filters } = parseRequest(browseQuerySchema, req.query);
    return discoverList(req, (exclude) => app.tmdb().browse(type, filters, page, exclude));
  });

  app.get(genresPath(':type'), async (req) => {
    const { type } = parseRequest(typeParamsSchema, req.params);
    return parseUpstream(SERVICE, genresResponseSchema, { genres: await app.tmdb().genres(type) });
  });

  app.get(providersPath(':type'), async (req) => {
    const { type } = parseRequest(typeParamsSchema, req.params);
    return parseUpstream(SERVICE, providersResponseSchema, { providers: await app.tmdb().providers(type) });
  });

  app.get(SEARCH_PATH, async (req) => {
    const { q, page } = parseRequest(searchQuerySchema, req.query);
    const found = parseUpstream(SERVICE, mediaSearchResultsSchema, await app.tmdb().searchMulti(q, page));
    const results = forViewer(app.data.db, viewerOf(req), found.results);
    return { ...found, results: await app.availability.withStatuses(results) };
  });

  app.get(personPath(':id'), async (req) => {
    const { id } = parseRequest(idParamsSchema, req.params);
    const person = parseUpstream(
      SERVICE,
      personDetailsSchema,
      await orTitleNotFound(() => app.tmdb().person(id), 'Personne introuvable'),
    );
    // Titres bloqués retirés (membres) ou marqués (gestionnaires), puis statuts des deux listes en un seul lot.
    const credits = await app.availability.withStatuses(
      forViewer(app.data.db, viewerOf(req), [...person.movies, ...person.shows]),
    );
    return {
      ...person,
      movies: credits.filter((credit) => credit.type === 'movie'),
      shows: credits.filter((credit) => credit.type === 'tv'),
    };
  });

  app.get(collectionPath(':id'), async (req) => {
    const { id } = parseRequest(idParamsSchema, req.params);
    const collection = parseUpstream(
      SERVICE,
      collectionDetailsSchema,
      await orTitleNotFound(() => app.tmdb().collection(id), 'Saga introuvable'),
    );
    const parts = forViewer(app.data.db, viewerOf(req), collection.parts);
    return { ...collection, parts: await app.availability.withStatuses(parts) };
  });

  app.get(mediaPath(':type', ':id'), async (req) => {
    const { type, id } = parseRequest(typeIdParamsSchema, req.params);
    const details = await app.availability.withDetailsStatus(await loadDetails(app.tmdb(), type, id));
    const blocked = blockOf(app.data, details);
    return blocked ? { ...details, blocked } : details;
  });
};
