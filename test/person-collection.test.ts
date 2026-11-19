import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { type Data, openDataDir } from '../src/server/db/index.ts';
import { media, requests } from '../src/server/db/schema.ts';
import { setSetting } from '../src/server/services/settings.ts';
import type { CollectionDetails, MediaDetails, PersonDetails } from '../src/shared/media.ts';
import type { Role } from '../src/shared/roles.ts';
import { type FakeHandler, type FakeRoutes, startFakeServer, status } from './fake-server.ts';
import { loginAs, trackTempDirs } from './helpers.ts';

const tempDir = trackTempDirs();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const V3_KEY = 'abcdef0123456789abcdef0123456789';

/** Réponse selon la langue demandée : le français d'abord, l'anglais au repli. */
const byLanguage =
  (fr: unknown, en: unknown): FakeHandler =>
  (req, res) =>
    status(200, req.query.language === 'en-US' ? en : fr)(req, res);

async function setup(routes: FakeRoutes) {
  const server = await startFakeServer({ 'GET /movie/603': { id: 603, title: 'Matrix' }, ...routes });
  const data = openDataDir(tempDir());
  setSetting(data.db, data.cryptoKey, 'tmdb', { apiKey: V3_KEY });
  const app = await buildApp({ data, upstreams: { tmdbUrl: server.url } });
  cleanups.push(() => app.close(), server.close);
  const as = async (role: Role) => {
    const { headers, user } = await loginAs(app, role);
    return {
      userId: user.id,
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload }),
    };
  };
  return { app, data, server, as };
}

/** Demande en attente d'un film : son statut (« pending ») se lit sans serveur multimédia ni Radarr. */
function requestMovie({ db }: Data, userId: string, tmdbId: number) {
  const row = db.insert(media).values({ type: 'movie', tmdbId, statusUpdatedAt: new Date() }).returning().get();
  db.insert(requests).values({ mediaId: row.id, userId, status: 'pending' }).run();
}

const credit = (id: number, media_type: 'movie' | 'tv', popularity: number, extra: object = {}) => ({
  id,
  media_type,
  popularity,
  ...(media_type === 'movie'
    ? { title: `Film ${id}`, release_date: '2001-05-05' }
    : { name: `Série ${id}`, first_air_date: '2010-01-01' }),
  poster_path: `/p${id}.jpg`,
  ...extra,
});

const person = {
  id: 6384,
  name: 'Keanu Reeves',
  profile_path: '/keanu.jpg',
  known_for_department: 'Acting',
  birthday: '1964-09-02',
  deathday: null,
  place_of_birth: 'Beyrouth, Liban',
  biography: 'Acteur canadien.',
  combined_credits: {
    cast: [
      credit(604, 'movie', 10),
      credit(603, 'movie', 80),
      credit(900, 'tv', 5),
      { id: 7, media_type: 'person', name: 'À ignorer' },
    ],
    crew: [credit(604, 'movie', 10), credit(605, 'movie', 30)],
  },
};

describe('GET /api/person/:id', () => {
  it('renvoie la fiche et la filmographie : une entrée par titre, rôles réunis, films et séries, du plus populaire', async () => {
    const { as } = await setup({ 'GET /person/6384': person });
    const res = await (await as('member')).get('/api/person/6384');

    expect(res.statusCode).toBe(200);
    const body = res.json<PersonDetails>();
    expect(body).toMatchObject({
      id: 6384,
      name: 'Keanu Reeves',
      profilePath: '/keanu.jpg',
      knownForDepartment: 'Acting',
      birthday: '1964-09-02',
      deathday: null,
      placeOfBirth: 'Beyrouth, Liban',
      biography: 'Acteur canadien.',
    });
    expect(body.movies.map((m) => [m.tmdbId, m.roles])).toEqual([
      [603, ['actor']],
      [605, ['crew']],
      [604, ['actor', 'crew']],
    ]);
    expect(body.shows.map((s) => [s.tmdbId, s.type, s.roles])).toEqual([[900, 'tv', ['actor']]]);
    expect(body.movies[0]).toMatchObject({ title: 'Film 603', year: 2001, posterPath: '/p603.jpg' });
  });

  it('écarte les crédits pour adultes', async () => {
    const cast = [credit(603, 'movie', 80), credit(666, 'movie', 90, { adult: true })];
    const { as } = await setup({ 'GET /person/6384': { ...person, combined_credits: { cast, crew: [] } } });
    const body = (await (await as('member')).get('/api/person/6384')).json<PersonDetails>();
    expect(body.movies.map((m) => m.tmdbId)).toEqual([603]);
  });

  it('joint le statut de chaque titre', async () => {
    const { as, data } = await setup({ 'GET /person/6384': person });
    const member = await as('member');
    requestMovie(data, member.userId, 603);
    const body = (await member.get('/api/person/6384')).json<PersonDetails>();

    expect(body.movies.map((m) => [m.tmdbId, m.status])).toEqual([
      [603, 'pending'],
      [605, undefined],
      [604, undefined],
    ]);
  });

  it('complète une biographie vide en anglais, sans échouer si l’anglais manque', async () => {
    const { as, server } = await setup({
      'GET /person/6384': byLanguage({ ...person, biography: '' }, { id: 6384, biography: 'Canadian actor.' }),
    });
    const member = await as('member');

    expect((await member.get('/api/person/6384')).json<PersonDetails>().biography).toBe('Canadian actor.');
    expect(server.requests.map((r) => r.query.language)).toEqual(['fr-FR', 'en-US']);
  });

  it('garde une biographie vide quand l’anglais échoue aussi', async () => {
    const { as } = await setup({
      'GET /person/6384': (req, res) =>
        status(req.query.language === 'en-US' ? 500 : 200, { ...person, biography: '' })(req, res),
    });
    const res = await (await as('member')).get('/api/person/6384');

    expect(res.statusCode).toBe(200);
    expect(res.json<PersonDetails>().biography).toBe('');
  });

  it('retire les titres bloqués pour un membre, les marque pour un gestionnaire', async () => {
    const { as } = await setup({ 'GET /person/6384': person });
    const manager = await as('manager');
    expect((await manager.post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 })).statusCode).toBe(200);

    const forMember = (await (await as('member')).get('/api/person/6384')).json<PersonDetails>();
    expect(forMember.movies.map((m) => m.tmdbId)).toEqual([605, 604]);

    const forManager = (await manager.get('/api/person/6384')).json<PersonDetails>();
    expect(forManager.movies.map((m) => [m.tmdbId, m.blocked])).toEqual([
      [603, { by: 'title' }],
      [605, undefined],
      [604, undefined],
    ]);
  });

  it('renvoie 404 « Personne introuvable » quand TMDB ne la connaît pas', async () => {
    const { as } = await setup({ 'GET /person/9': status(404, { status_code: 34 }) });
    const res = await (await as('member')).get('/api/person/9');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Personne introuvable' });
  });
});

const collection = {
  id: 2344,
  name: 'Saga Matrix',
  overview: 'Trois films.',
  poster_path: '/saga.jpg',
  backdrop_path: '/saga-bg.jpg',
  parts: [
    { id: 605, title: 'Matrix Revolutions', release_date: '2003-11-05' },
    { id: 700, title: 'À venir' },
    { id: 603, title: 'Matrix', release_date: '1999-03-30', poster_path: '/m.jpg' },
    { id: 604, title: 'Matrix Reloaded', release_date: '2003-05-15' },
  ],
};

describe('GET /api/collection/:id', () => {
  it('renvoie la saga, ses films du plus ancien au plus récent (sans date en dernier) et leurs statuts', async () => {
    const { as, data } = await setup({ 'GET /collection/2344': collection });
    const member = await as('member');
    requestMovie(data, member.userId, 603);
    const res = await member.get('/api/collection/2344');

    expect(res.statusCode).toBe(200);
    const body = res.json<CollectionDetails>();
    expect(body).toMatchObject({
      id: 2344,
      name: 'Saga Matrix',
      overview: 'Trois films.',
      posterPath: '/saga.jpg',
      backdropPath: '/saga-bg.jpg',
    });
    expect(body.parts.map((p) => [p.tmdbId, p.type, p.year, p.status])).toEqual([
      [603, 'movie', 1999, 'pending'],
      [604, 'movie', 2003, undefined],
      [605, 'movie', 2003, undefined],
      [700, 'movie', null, undefined],
    ]);
  });

  it('complète un synopsis vide en anglais', async () => {
    const { as } = await setup({
      'GET /collection/2344': byLanguage({ ...collection, overview: '' }, { id: 2344, overview: 'Three films.' }),
    });
    const res = await (await as('member')).get('/api/collection/2344');

    expect(res.json<CollectionDetails>().overview).toBe('Three films.');
  });

  it('retire les films bloqués pour un membre', async () => {
    const { as } = await setup({ 'GET /collection/2344': collection });
    await (await as('manager')).post('/api/blocklist/titles', { mediaType: 'movie', tmdbId: 603 });
    const res = await (await as('member')).get('/api/collection/2344');

    expect(res.json<CollectionDetails>().parts.map((p) => p.tmdbId)).toEqual([604, 605, 700]);
  });

  it('renvoie 404 « Saga introuvable » quand TMDB ne la connaît pas', async () => {
    const { as } = await setup({ 'GET /collection/9': status(404, { status_code: 34 }) });
    const res = await (await as('member')).get('/api/collection/9');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Saga introuvable' });
  });
});

describe('fiche : équipe et saga', () => {
  const crew = (id: number, job: string) => ({ id, name: `Personne ${id}`, job, profile_path: null });

  it('liste réalisation et scénario (une entrée par personne) et la saga du film', async () => {
    const { as } = await setup({
      'GET /movie/603': {
        id: 603,
        title: 'Matrix',
        overview: 'Un pirate.',
        credits: {
          cast: [],
          crew: [
            crew(1, 'Director'),
            crew(1, 'Screenplay'),
            crew(2, 'Writer'),
            crew(2, 'Screenplay'),
            crew(3, 'Director of Photography'),
          ],
        },
        belongs_to_collection: { id: 2344, name: 'Saga Matrix', poster_path: '/saga.jpg', backdrop_path: null },
      },
    });
    const body = (await (await as('member')).get('/api/media/movie/603')).json<MediaDetails>();

    expect(body.crew).toEqual([
      { id: 1, name: 'Personne 1', jobs: ['director', 'writer'], profilePath: null },
      { id: 2, name: 'Personne 2', jobs: ['writer'], profilePath: null },
    ]);
    expect(body.collection).toEqual({ id: 2344, name: 'Saga Matrix', posterPath: '/saga.jpg', backdropPath: null });
  });

  it('ajoute les créateurs d’une série et omet la saga absente', async () => {
    const { as } = await setup({
      'GET /tv/1399': {
        id: 1399,
        name: 'Série',
        overview: 'Résumé.',
        created_by: [{ id: 9, name: 'Créatrice', profile_path: '/c.jpg' }],
        credits: { cast: [] },
        belongs_to_collection: null,
      },
    });
    const body = (await (await as('member')).get('/api/media/tv/1399')).json<MediaDetails>();

    expect(body.crew).toEqual([{ id: 9, name: 'Créatrice', jobs: ['creator'], profilePath: '/c.jpg' }]);
    expect(body.collection).toBeNull();
  });
});

describe('validation et erreurs', () => {
  it.each(['/api/person/0', '/api/person/abc', '/api/collection/-1', '/api/collection/1.5'])(
    '%s → 400',
    async (url) => {
      const { as, server } = await setup({});
      const res = await (await as('member')).get(url);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Requête invalide' });
      expect(server.requests).toHaveLength(0);
    },
  );

  it.each(['/api/person/6384', '/api/collection/2344'])('%s → 502 sur une réponse hors contrat', async (url) => {
    const { as } = await setup({
      'GET /person/6384': { ...person, id: 'x' },
      'GET /collection/2344': { ...collection, parts: [{ id: 'x' }] },
    });
    const res = await (await as('member')).get(url);

    expect(res.statusCode).toBe(502);
  });

  it('exige une session', async () => {
    const { app } = await setup({});

    expect((await app.inject({ method: 'GET', url: '/api/person/6384' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/collection/2344' })).statusCode).toBe(401);
  });
});
