import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, errorMessage } from '../src/client/lib/http.ts';
import { downloadPercent } from '../src/client/lib/status.ts';
import type { MediaDetails, Season } from '../src/shared/media.ts';
import { isAiredSeason, isoDay, isRequestable, requestableSeasons, uncoveredSeasons } from '../src/shared/requests.ts';
import { isRequestableStatus, mediaStatuses } from '../src/shared/status.ts';

describe('downloadPercent', () => {
  it('arrondit la progression en pourcentage entier', () => {
    expect(downloadPercent({ status: 'downloading', progress: 0.42 })).toBe(42);
    expect(downloadPercent({ status: 'downloading', progress: 0.426 })).toBe(43);
  });

  it('borne la progression entre 0 et 100', () => {
    expect(downloadPercent({ status: 'downloading', progress: -0.2 })).toBe(0);
    expect(downloadPercent({ status: 'downloading', progress: 1.4 })).toBe(100);
  });

  it('ne donne rien hors téléchargement ou sans progression', () => {
    expect(downloadPercent({ status: 'downloading' })).toBeUndefined();
    expect(downloadPercent({ status: 'available', progress: 0.5 })).toBeUndefined();
    expect(downloadPercent({})).toBeUndefined();
  });
});

describe('isRequestableStatus', () => {
  it('autorise une demande sans statut, partielle ou refusée', () => {
    expect(isRequestableStatus()).toBe(true);
    expect(isRequestableStatus('partial')).toBe(true);
    expect(isRequestableStatus('declined')).toBe(true);
  });

  it('refuse une demande pour tous les autres statuts', () => {
    const blocked = mediaStatuses.filter((status) => !isRequestableStatus(status));
    expect(blocked).toEqual(['available', 'downloading', 'requested', 'pending']);
  });
});

const DAY = '2026-11-17';
const season = (seasonNumber: number, extra: Partial<Season> = {}): Season => ({
  seasonNumber,
  episodeCount: 10,
  airDate: '2024-01-01',
  ...extra,
});
const tv = (status: MediaDetails['status'], seasons: Season[], fourK?: MediaDetails['fourK']) => ({
  type: 'tv' as const,
  status,
  seasons,
  fourK,
});
const numbers = (seasons: Season[]) => seasons.map((s) => s.seasonNumber);

describe('saisons demandables', () => {
  it('saison 1 demandée (en attente, envoyée) et saison 2 intacte : la saison 2 se demande', () => {
    const seasons = [season(1, { status: 'requested' }), season(2)];
    expect(numbers(requestableSeasons(seasons, DAY))).toEqual([2]);
    expect(isRequestable(tv('requested', seasons), DAY)).toBe(true);
    const pending = [season(1, { status: 'pending' }), season(2)];
    expect(isRequestable(tv('pending', pending), DAY)).toBe(true);
  });

  it('toutes les saisons disponibles ou déjà demandées : rien à demander', () => {
    const covered = [season(1, { status: 'available' }), season(2, { status: 'requested' })];
    expect(isRequestable(tv('requested', covered), DAY)).toBe(false);
    expect(isRequestable(tv('available', [season(1, { status: 'available' })]), DAY)).toBe(false);
  });

  it('ignore les spéciaux, les saisons pas encore diffusées et celles en téléchargement', () => {
    const seasons = [
      season(0),
      season(1, { status: 'requested' }),
      season(2, { airDate: '2099-01-01', episodeCount: 0 }),
      season(3, { status: 'downloading', progress: 0.5 }),
    ];
    expect(isRequestable(tv('requested', seasons), DAY)).toBe(false);
  });

  it('un titre partiel ou refusé reste demandable d’après son statut, même sans saison demandable', () => {
    const seasons = [season(1, { status: 'available' }), season(2, { status: 'downloading', progress: 0.4 })];
    expect(isRequestable(tv('partial', seasons), DAY)).toBe(true);
    expect(isRequestable(tv('declined', seasons), DAY)).toBe(true);
    expect(isRequestable(tv('downloading', seasons), DAY)).toBe(false);
  });

  it('une saison partielle ou refusée se redemande', () => {
    const seasons = [season(1, { status: 'partial' }), season(2, { status: 'declined' })];
    expect(numbers(requestableSeasons(seasons, DAY))).toEqual([1, 2]);
  });

  it('un titre disponible ne se demande jamais, même si ses saisons sont inconnues', () => {
    expect(isRequestable(tv('available', [season(1)]), DAY)).toBe(false);
  });

  it('en 4K, seul le statut 4K compte', () => {
    const seasons = [
      season(1, { status: 'available', fourK: { status: 'requested' } }),
      season(2, { status: 'available' }),
    ];
    const media = tv('available', seasons, { status: 'requested' });
    expect(isRequestable(media, DAY, true)).toBe(true);
    expect(numbers(requestableSeasons(seasons, DAY, true))).toEqual([2]);
    expect(isRequestable(media, DAY)).toBe(false);
    const all4k = [season(1, { fourK: { status: 'requested' } }), season(2, { fourK: { status: 'available' } })];
    expect(isRequestable(tv('available', all4k, { status: 'requested' }), DAY, true)).toBe(false);
  });

  it('un film, ou un titre sans saisons connues (affiche), suit son statut', () => {
    expect(isRequestable({ type: 'movie' }, DAY)).toBe(true);
    expect(isRequestable({ type: 'movie', status: 'requested' }, DAY)).toBe(false);
    expect(isRequestable({ type: 'tv', status: 'requested' }, DAY)).toBe(false);
    expect(isRequestable({ type: 'tv', status: 'partial' }, DAY)).toBe(true);
    expect(isRequestable({ type: 'movie', status: 'available', fourK: { status: 'declined' } }, DAY, true)).toBe(true);
  });

  it('côté serveur : les saisons déjà couvertes par une demande en cours sont retirées', () => {
    expect(uncoveredSeasons([1, 2, 3], new Set([1, 3]))).toEqual([2]);
    expect(uncoveredSeasons([1], new Set([1]))).toEqual([]);
  });
});

describe('saisons diffusées (même règle côté feuille et côté serveur)', () => {
  it('le jour est celui d’UTC, quel que soit le fuseau du navigateur', () => {
    expect(isoDay(Date.UTC(2026, 10, 17, 23, 30))).toBe('2026-11-17');
    expect(isoDay(new Date('2026-11-18T00:30:00+01:00'))).toBe('2026-11-17');
  });

  it('diffusée : au moins un épisode et une date passée ou du jour', () => {
    const day = '2026-11-17';
    expect(isAiredSeason({ episodeCount: 8, airDate: '2026-11-17' }, day)).toBe(true);
    expect(isAiredSeason({ episodeCount: 8, airDate: '2026-11-18' }, day)).toBe(false);
    expect(isAiredSeason({ episodeCount: 0, airDate: '2020-01-01' }, day)).toBe(false);
    expect(isAiredSeason({ episodeCount: 8, airDate: null }, day)).toBe(false);
  });
});

describe('apiGet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('transforme une panne réseau en ApiError au message français', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const error = await apiGet('/api/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(errorMessage(error)).toBe('Le serveur ne répond pas. Vérifiez votre connexion.');
  });
});

describe('errorMessage', () => {
  it('montre le message de l’API, panne réseau comprise, jamais celui d’une autre erreur', () => {
    expect(errorMessage(new ApiError(0, 'Le serveur ne répond pas. Vérifiez votre connexion.'))).toBe(
      'Le serveur ne répond pas. Vérifiez votre connexion.',
    );
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Erreur inattendue du serveur');
    expect(errorMessage(new Error('boom'), 'L’annulation n’a pas abouti.')).toBe('L’annulation n’a pas abouti.');
  });
});
