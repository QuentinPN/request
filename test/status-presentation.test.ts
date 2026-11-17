import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, errorMessage } from '../src/client/lib/http.ts';
import { canRequest, downloadPercent } from '../src/client/lib/status.ts';
import { isAiredSeason, isoDay } from '../src/shared/requests.ts';
import { mediaStatuses } from '../src/shared/status.ts';

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

describe('canRequest', () => {
  it('autorise une demande sans statut, partielle ou refusée', () => {
    expect(canRequest()).toBe(true);
    expect(canRequest('partial')).toBe(true);
    expect(canRequest('declined')).toBe(true);
  });

  it('refuse une demande pour tous les autres statuts', () => {
    const blocked = mediaStatuses.filter((status) => !canRequest(status));
    expect(blocked).toEqual(['available', 'downloading', 'requested', 'pending']);
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
