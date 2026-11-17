import { describe, expect, it } from 'vitest';
import { canRequest, downloadPercent } from '../src/client/lib/status.ts';
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
