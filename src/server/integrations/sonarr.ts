import { z } from 'zod';
import {
  type ArrConfig,
  type ArrTestResult,
  arrClient,
  createOrRecover,
  lenient,
  notFound,
  parseArrWebhook,
  profileSchema,
  testArr,
  toProfile,
} from './arr.ts';

const seasonSchema = z.looseObject({
  seasonNumber: z.number(),
  monitored: z.boolean().catch(false),
  statistics: lenient(
    z.looseObject({
      episodeFileCount: z.number().catch(0),
      episodeCount: z.number().catch(0),
      totalEpisodeCount: lenient(z.number()),
    }),
  ),
});
const seriesSchema = z.looseObject({
  id: z.number().catch(0),
  monitored: z.boolean().catch(false),
  seasons: z.array(seasonSchema),
});
type Series = z.infer<typeof seriesSchema>;

export type SeriesType = 'standard' | 'anime' | 'daily';

export interface AddSeriesInput {
  tvdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  seriesType: SeriesType;
  /** Saisons demandées (numéros Sonarr, 0 = épisodes spéciaux). */
  seasons: number[];
  /** Lance la recherche des épisodes manquants (ou des saisons ajoutées, pour une série existante). */
  search: boolean;
  /** Sonarr v3 seulement (liste `languageProfiles` du test de connexion) ; ne pas renseigner en v4. */
  languageProfileId?: number;
}

export interface SeasonStatus {
  seasonNumber: number;
  episodeFileCount: number;
  episodeCount: number;
  totalEpisodeCount?: number;
}

export interface SonarrTestResult extends ArrTestResult {
  /** Présent uniquement en Sonarr v3 (supprimé en v4). */
  languageProfiles?: Array<{ id: number; name: string }>;
}

export async function testSonarr(config: ArrConfig): Promise<SonarrTestResult> {
  const result = await testArr('sonarr', config);
  if (Number.parseInt(result.version, 10) >= 4) return result;
  const profiles = await arrClient('sonarr', config).get('/languageprofile', z.array(profileSchema));
  return { ...result, languageProfiles: profiles.map(toProfile) };
}

/** Fiche Sonarr d'une série d'après son id TVDB ; `id > 0` si la série est déjà dans la bibliothèque. */
export async function lookupSeries(config: ArrConfig, tvdbId: number) {
  const found = await arrClient('sonarr', config).get('/series/lookup', z.array(seriesSchema), {
    term: `tvdb:${tvdbId}`,
  });
  const series = found[0];
  if (!series) throw notFound('sonarr', 'Série');
  return series;
}

const post = (config: ArrConfig, path: string, body: unknown) =>
  arrClient('sonarr', config).post(path, z.unknown(), body);

/** Série existante : ajoute les saisons demandées à celles déjà suivies (jamais l'inverse), puis les cherche. */
async function addSeasonsToSeries(config: ArrConfig, sonarrId: number, seasons: number[], search: boolean) {
  const client = arrClient('sonarr', config);
  const series = await client.get(`/series/${sonarrId}`, seriesSchema);
  const requested = new Set(seasons);
  const known = new Set(series.seasons.map((s) => s.seasonNumber));
  await client.put(`/series/${sonarrId}`, z.unknown(), {
    ...series,
    monitored: true,
    seasons: [
      ...series.seasons.map((s) => (requested.has(s.seasonNumber) ? { ...s, monitored: true } : s)),
      ...seasons.filter((n) => !known.has(n)).map((seasonNumber) => ({ seasonNumber, monitored: true })),
    ],
  });
  if (search) {
    for (const seasonNumber of seasons) {
      await post(config, '/command', { name: 'SeasonSearch', seriesId: sonarrId, seasonNumber });
    }
  }
}

/**
 * Ajoute la série avec seulement les saisons demandées suivies. Si elle existe déjà, ajoute ces saisons
 * à celles suivies et les cherche : rappeler la fonction est sans danger.
 */
export async function addSeries(config: ArrConfig, input: AddSeriesInput): Promise<{ sonarrId: number }> {
  const lookup = await lookupSeries(config, input.tvdbId);
  const existing = (id: number) =>
    addSeasonsToSeries(config, id, input.seasons, input.search).then(() => ({ sonarrId: id }));
  if (lookup.id > 0) return existing(lookup.id);

  const requested = new Set(input.seasons);
  const { id: _id, ...series } = lookup;
  return createOrRecover(
    async () => {
      const created = await arrClient('sonarr', config).post('/series', seriesSchema, {
        ...series,
        tvdbId: input.tvdbId,
        qualityProfileId: input.qualityProfileId,
        rootFolderPath: input.rootFolderPath,
        seriesType: input.seriesType,
        monitored: true, // requis : Sonarr ne télécharge aucun épisode d'une série non suivie
        seasonFolder: true,
        seasons: lookup.seasons.map((s) => ({ ...s, monitored: requested.has(s.seasonNumber) })),
        ...(input.languageProfileId !== undefined && { languageProfileId: input.languageProfileId }),
        addOptions: { searchForMissingEpisodes: input.search, searchForCutoffUnmetEpisodes: false },
      });
      return { sonarrId: created.id };
    },
    async () => {
      const again = await lookupSeries(config, input.tvdbId);
      return again.id > 0 ? existing(again.id) : undefined;
    },
  );
}

/** Avancement par saison (épisodes présents / diffusés / total), d'après les statistiques de la série. */
export async function getSeriesSeasonStatus(config: ArrConfig, sonarrId: number): Promise<SeasonStatus[]> {
  const series: Series = await arrClient('sonarr', config).get(`/series/${sonarrId}`, seriesSchema);
  return series.seasons.map(({ seasonNumber, statistics }) => ({
    seasonNumber,
    episodeFileCount: statistics?.episodeFileCount ?? 0,
    episodeCount: statistics?.episodeCount ?? 0,
    ...(statistics?.totalEpisodeCount !== undefined && { totalEpisodeCount: statistics.totalEpisodeCount }),
  }));
}

export const parseSonarrWebhook = (body: unknown) => parseArrWebhook(body, 'series');
