import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { getQueue } from '../src/server/integrations/arr.ts';
import type { IntegrationError } from '../src/server/integrations/http.ts';
import {
  addMovie,
  getMovieByTmdbId,
  getMovieStatus,
  lookupMovie,
  parseRadarrWebhook,
  testRadarr,
} from '../src/server/integrations/radarr.ts';
import {
  addSeries,
  getSeriesSeasonStatus,
  lookupSeries,
  parseSonarrWebhook,
  testSonarr,
} from '../src/server/integrations/sonarr.ts';
import { closedPortUrl, type FakeRoutes, sequence, startFakeServer, status } from './fake-server.ts';

const API_KEY = 'secret-key-123';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/arr/${name}.json`, import.meta.url), 'utf8'));

const closers: Array<() => Promise<void>> = [];
const serve = async (routes: FakeRoutes) => {
  const server = await startFakeServer(routes);
  closers.push(server.close);
  const config = { url: server.url, apiKey: API_KEY };
  return { ...server, config };
};
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const failure = async (promise: Promise<unknown>): Promise<IntegrationError> => {
  try {
    await promise;
  } catch (error) {
    return error as IntegrationError;
  }
  throw new Error('aurait dû échouer');
};

const connectionRoutes = (version: string): FakeRoutes => ({
  'GET /api/v3/system/status': { version, appName: 'x' },
  'GET /api/v3/qualityprofile': [{ id: 1, name: 'HD-1080p', cutoff: 7 }],
  'GET /api/v3/rootfolder': [{ id: 2, path: '/movies', freeSpace: 1000, accessible: true }],
});

describe('testRadarr', () => {
  it('renvoie version, profils et dossiers racine, avec la clé en en-tête', async () => {
    const { config, requests } = await serve(connectionRoutes('5.2.0'));
    expect(await testRadarr(config)).toEqual({
      version: '5.2.0',
      qualityProfiles: [{ id: 1, name: 'HD-1080p' }],
      rootFolders: [{ id: 2, path: '/movies', freeSpace: 1000 }],
    });
    expect(requests.every((r) => r.headers['x-api-key'] === API_KEY)).toBe(true);
  });

  it('signale une clé refusée sans la divulguer', async () => {
    const { config } = await serve({ ...connectionRoutes('5'), 'GET /api/v3/system/status': status(401) });
    const error = await failure(testRadarr(config));
    expect(error.kind).toBe('unauthorized');
    expect(error.message).toBe("Clé d'API refusée par Radarr");
    expect(JSON.stringify(error) + error.message + error.url).not.toContain(API_KEY);
  });

  it('signale un service injoignable', async () => {
    const error = await failure(testRadarr({ url: await closedPortUrl(), apiKey: API_KEY }));
    expect(error.kind).toBe('unreachable');
    expect(error.message).toBe('Radarr injoignable à cette adresse');
  });
});

describe('testSonarr', () => {
  it('v4 : pas de profils de langue', async () => {
    const { config, requests } = await serve(connectionRoutes('4.0.9.2244'));
    const result = await testSonarr(config);
    expect(result.version).toBe('4.0.9.2244');
    expect(result).not.toHaveProperty('languageProfiles');
    expect(requests.some((r) => r.path.endsWith('languageprofile'))).toBe(false);
  });

  it('v3 : ajoute les profils de langue', async () => {
    const { config } = await serve({
      ...connectionRoutes('3.0.10.1567'),
      'GET /api/v3/languageprofile': [{ id: 1, name: 'Français' }],
    });
    expect((await testSonarr(config)).languageProfiles).toEqual([{ id: 1, name: 'Français' }]);
  });
});

describe('Radarr : films', () => {
  it('lookupMovie accepte un objet ou une liste', async () => {
    const { config, requests } = await serve({ 'GET /api/v3/movie/lookup/tmdb': [fixture('radarr-lookup')] });
    expect((await lookupMovie(config, 603)).tmdbId).toBe(603);
    expect(requests[0]?.query).toEqual({ tmdbId: '603' });
  });

  it('addMovie envoie le film avec recherche et renvoie son id', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/movie/lookup/tmdb': fixture('radarr-lookup'),
      'POST /api/v3/movie': (_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 42, tmdbId: 603 }));
      },
    });
    const result = await addMovie(config, {
      tmdbId: 603,
      qualityProfileId: 1,
      rootFolderPath: '/movies',
      minimumAvailability: 'released',
      search: true,
    });
    expect(result).toEqual({ radarrId: 42 });
    const body = requests.find((r) => r.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      title: 'The Matrix',
      tmdbId: 603,
      qualityProfileId: 1,
      rootFolderPath: '/movies',
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: true },
    });
    expect(body).not.toHaveProperty('id');
  });

  it('addMovie est idempotent : film déjà connu du lookup', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/movie/lookup/tmdb': { ...fixture('radarr-lookup'), id: 9 },
    });
    expect(await addMovie(config, { tmdbId: 603, qualityProfileId: 1, rootFolderPath: '/m', search: true })).toEqual({
      radarrId: 9,
    });
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('addMovie est idempotent : 400 « déjà ajouté » puis film retrouvé', async () => {
    const { config } = await serve({
      'GET /api/v3/movie/lookup/tmdb': fixture('radarr-lookup'),
      'POST /api/v3/movie': status(400, [{ errorMessage: 'This movie has already been added' }]),
      'GET /api/v3/movie': [{ id: 77, tmdbId: 603, hasFile: false, monitored: true }],
    });
    expect(await addMovie(config, { tmdbId: 603, qualityProfileId: 1, rootFolderPath: '/m', search: true })).toEqual({
      radarrId: 77,
    });
  });

  it("addMovie relance l'erreur 400 si le film reste introuvable", async () => {
    const { config } = await serve({
      'GET /api/v3/movie/lookup/tmdb': fixture('radarr-lookup'),
      'POST /api/v3/movie': status(400),
      'GET /api/v3/movie': [],
    });
    const error = await failure(
      addMovie(config, { tmdbId: 603, qualityProfileId: 1, rootFolderPath: '/m', search: true }),
    );
    expect(error.status).toBe(400);
  });

  it('getMovieByTmdbId et getMovieStatus', async () => {
    const { config } = await serve({
      'GET /api/v3/movie': [{ id: 12, hasFile: true, monitored: true }],
      'GET /api/v3/movie/12': { id: 12, hasFile: false, monitored: true },
    });
    expect(await getMovieByTmdbId(config, 603)).toEqual({ radarrId: 12, hasFile: true, monitored: true });
    expect(await getMovieStatus(config, 12)).toEqual({ radarrId: 12, hasFile: false, monitored: true });
  });

  it('getMovieByTmdbId renvoie null si absent', async () => {
    const { config } = await serve({ 'GET /api/v3/movie': [] });
    expect(await getMovieByTmdbId(config, 1)).toBeNull();
  });
});

describe('Sonarr : séries', () => {
  const baseInput = {
    tvdbId: 81189,
    qualityProfileId: 4,
    rootFolderPath: '/tv',
    seriesType: 'standard' as const,
    seasons: [1, 3],
    search: true,
  };

  it('lookupSeries interroge par tvdb: ; série inconnue → not_found', async () => {
    const { config, requests } = await serve({ 'GET /api/v3/series/lookup': fixture('sonarr-lookup') });
    expect((await lookupSeries(config, 81189)).id).toBe(0);
    expect(requests[0]?.query).toEqual({ term: 'tvdb:81189' });

    const empty = await serve({ 'GET /api/v3/series/lookup': [] });
    expect((await failure(lookupSeries(empty.config, 1))).kind).toBe('not_found');
  });

  it('nouvelle série : seules les saisons demandées sont suivies, recherche demandée, pas de languageProfileId', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/series/lookup': fixture('sonarr-lookup'),
      'POST /api/v3/series': (_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...fixture('sonarr-series'), id: 7 }));
      },
    });
    expect(await addSeries(config, baseInput)).toEqual({ sonarrId: 7 });
    const body = requests.find((r) => r.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      tvdbId: 81189,
      qualityProfileId: 4,
      rootFolderPath: '/tv',
      seriesType: 'standard',
      monitored: true,
      addOptions: { searchForMissingEpisodes: true },
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
        { seasonNumber: 3, monitored: true },
      ],
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('languageProfileId');
  });

  it('transmet languageProfileId (v3) quand il est fourni', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/series/lookup': fixture('sonarr-lookup'),
      'POST /api/v3/series': { ...fixture('sonarr-series'), id: 7 },
    });
    await addSeries(config, { ...baseInput, languageProfileId: 1 });
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({ languageProfileId: 1 });
  });

  it('série existante : ajoute les saisons aux saisons suivies puis les cherche (idempotent)', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/series/lookup': [{ ...fixture('sonarr-lookup')[0], id: 7 }],
      'GET /api/v3/series/7': fixture('sonarr-series'),
      'PUT /api/v3/series/7': {},
      'POST /api/v3/command': { id: 1 },
    });
    expect(await addSeries(config, baseInput)).toEqual({ sonarrId: 7 });
    expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v3/series')).toBe(false);

    const put = requests.find((r) => r.method === 'PUT')?.body as { seasons: unknown[]; path: string };
    expect(put.path).toBe('/tv/Breaking Bad');
    expect(put.seasons).toMatchObject([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
      { seasonNumber: 3, monitored: true },
    ]);
    expect(requests.filter((r) => r.path === '/api/v3/command').map((r) => r.body)).toEqual([
      { name: 'SeasonSearch', seriesId: 7, seasonNumber: 1 },
      { name: 'SeasonSearch', seriesId: 7, seasonNumber: 3 },
    ]);
  });

  it("400 à la création puis recherche en échec : relance la 400 d'origine", async () => {
    const lookupHandler = (id: number) => (_req: unknown, res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ ...fixture('sonarr-lookup')[0], id }]));
    };
    const { config } = await serve({
      'GET /api/v3/series/lookup': sequence(lookupHandler(0), status(500)),
      'POST /api/v3/series': status(400),
    });
    expect((await failure(addSeries(config, baseInput))).status).toBe(400);
  });

  it('série existante sans recherche : aucune commande', async () => {
    const { config, requests } = await serve({
      'GET /api/v3/series/lookup': [{ ...fixture('sonarr-lookup')[0], id: 7 }],
      'GET /api/v3/series/7': fixture('sonarr-series'),
      'PUT /api/v3/series/7': {},
    });
    await addSeries(config, { ...baseInput, search: false });
    expect(requests.some((r) => r.path === '/api/v3/command')).toBe(false);
  });

  it('400 à la création : retrouve la série existante et met à jour ses saisons', async () => {
    let lookups = 0;
    const { config, requests } = await serve({
      'GET /api/v3/series/lookup': (_req, res) => {
        const id = ++lookups === 1 ? 0 : 7;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ ...fixture('sonarr-lookup')[0], id }]));
      },
      'POST /api/v3/series': status(400),
      'GET /api/v3/series/7': fixture('sonarr-series'),
      'PUT /api/v3/series/7': {},
      'POST /api/v3/command': {},
    });
    expect(await addSeries(config, baseInput)).toEqual({ sonarrId: 7 });
    expect(requests.some((r) => r.method === 'PUT')).toBe(true);
  });

  it('getSeriesSeasonStatus lit les statistiques par saison', async () => {
    const { config } = await serve({ 'GET /api/v3/series/7': fixture('sonarr-series') });
    expect(await getSeriesSeasonStatus(config, 7)).toEqual([
      { seasonNumber: 0, episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 9 },
      { seasonNumber: 1, episodeFileCount: 7, episodeCount: 7, totalEpisodeCount: 7 },
      { seasonNumber: 2, episodeFileCount: 0, episodeCount: 13, totalEpisodeCount: 13 },
      { seasonNumber: 3, episodeFileCount: 0, episodeCount: 0 },
    ]);
  });
});

describe('getQueue', () => {
  const record = (n: number) => ({
    movieId: n,
    size: 1000,
    sizeleft: 250,
    timeleft: '00:10:00',
    status: 'downloading',
  });

  it('Radarr : normalise la progression et parcourt les pages', async () => {
    const total = 250;
    const { config, requests } = await serve({
      'GET /api/v3/queue': (req, res) => {
        const page = Number(req.query.page);
        const size = Number(req.query.pageSize);
        const records = Array.from({ length: total }, (_, i) => record(i + 1)).slice((page - 1) * size, page * size);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ page, pageSize: size, totalRecords: total, records }));
      },
    });
    const items = await getQueue('radarr', config);
    expect(items).toHaveLength(total);
    expect(items[0]).toEqual({ externalId: 1, progress: 0.75, timeleft: '00:10:00', status: 'downloading' });
    expect(requests.map((r) => r.query.page)).toEqual(['1', '2']);
  });

  it('Sonarr : saison et épisode, taille nulle, entrées hors appli ignorées', async () => {
    const { config } = await serve({
      'GET /api/v3/queue': {
        totalRecords: 4,
        records: [
          { seriesId: 7, episodeId: 31, seasonNumber: 2, size: 100, sizeleft: 0, status: 'completed' },
          {
            seriesId: 7,
            episodeId: 32,
            episode: { seasonNumber: 3 },
            size: 0,
            sizeleft: 0,
            timeleft: null,
            status: 'queued',
          },
          { seriesId: 8, size: 100, sizeleft: 500, status: 'paused' },
          { size: 100, sizeleft: 10, status: 'downloading' },
        ],
      },
    });
    expect(await getQueue('sonarr', config)).toEqual([
      { externalId: 7, episodeId: 31, seasonNumber: 2, progress: 1, timeleft: null, status: 'completed' },
      { externalId: 7, episodeId: 32, seasonNumber: 3, progress: 0, timeleft: null, status: 'queued' },
      { externalId: 8, progress: 0, timeleft: null, status: 'paused' },
    ]);
  });

  it('file vide', async () => {
    const { config } = await serve({ 'GET /api/v3/queue': { totalRecords: 0, records: [] } });
    expect(await getQueue('radarr', config)).toEqual([]);
  });
});

describe('webhooks', () => {
  it('Radarr : Download avec mise à niveau', () => {
    expect(parseRadarrWebhook(fixture('radarr-webhook-download'))).toEqual({
      event: 'download',
      tmdbId: 603,
      isUpgrade: true,
    });
  });

  it('Sonarr : Download, saisons triées sans doublon', () => {
    expect(parseSonarrWebhook(fixture('sonarr-webhook-download'))).toEqual({
      event: 'download',
      tmdbId: 1396,
      tvdbId: 81189,
      seasons: [2, 3],
      isUpgrade: false,
    });
  });

  it('Test, Grab et évènements inconnus', () => {
    expect(parseRadarrWebhook({ eventType: 'Test' })).toEqual({ event: 'test', isUpgrade: false });
    expect(parseSonarrWebhook({ eventType: 'Grab', series: { tvdbId: 5 } })).toEqual({
      event: 'grab',
      tvdbId: 5,
      isUpgrade: false,
    });
    expect(parseRadarrWebhook({ eventType: 'Rename', movie: { tmdbId: 1 } }).event).toBe('other');
  });

  it("charge malformée : 'other', sans lever d'erreur", () => {
    for (const body of [null, undefined, 'texte', 42, [], {}, { eventType: 7 }]) {
      expect(parseRadarrWebhook(body)).toEqual({ event: 'other', isUpgrade: false });
      expect(parseSonarrWebhook(body)).toEqual({ event: 'other', isUpgrade: false });
    }
  });

  it('champs douteux ignorés plutôt que bloquants', () => {
    expect(parseRadarrWebhook({ eventType: 'Download', isUpgrade: 'oui', movie: { tmdbId: 'abc' } })).toEqual({
      event: 'download',
      isUpgrade: false,
    });
  });
});
