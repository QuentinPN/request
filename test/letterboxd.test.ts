import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from '../src/server/lib/csv.ts';
import { matchMovie, normalizeTitle, parseLetterboxdWatchlist } from '../src/server/services/watchlist-import.ts';

describe('parseCsv', () => {
  it('lit guillemets, virgules et sauts de ligne dans un champ, et les guillemets doublés', () => {
    expect(parseCsv('a,b\n"x, y","il a dit ""oui""\nsur 2 lignes"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'il a dit "oui"\nsur 2 lignes'],
    ]);
  });

  it('accepte un guillemet ouvrant précédé d’espaces', () => {
    expect(parseCsv('a,b\n1,  "x, y"\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
    ]);
  });

  it('ignore le BOM, accepte \\r\\n et \\r, écarte les lignes vides', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('reconnaît le point-virgule et la tabulation d’après l’en-tête', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rend les lignes en objets, colonnes reconnues par leur nom sans tenir compte de l’ordre ni de la casse', () => {
    expect(parseCsvRecords('Year, NAME ,Date\n1999,Matrix,2024-01-01\n2000')).toEqual([
      { year: '1999', name: 'Matrix', date: '2024-01-01' },
      { year: '2000', name: '', date: '' },
    ]);
  });
});

describe('parseLetterboxdWatchlist', () => {
  it('lit le watchlist.csv de Letterboxd', () => {
    const csv = [
      'Date,Name,Year,Letterboxd URI',
      '2024-03-01,The Matrix,1999,https://boxd.it/abc',
      '2024-03-02,"Dr. Strangelove, or: How I Learned",1964,https://boxd.it/def',
      '2024-03-03,Sans année,,https://boxd.it/ghi',
    ].join('\n');
    expect(parseLetterboxdWatchlist(csv)).toEqual([
      { title: 'The Matrix', year: 1999 },
      { title: 'Dr. Strangelove, or: How I Learned', year: 1964 },
      { title: 'Sans année', year: null },
    ]);
  });

  it('tolère BOM, colonnes réordonnées et guillemets autour de tout', () => {
    const csv = '﻿"Letterboxd URI","Year","Name","Date"\r\n"https://boxd.it/a","2010","Inception","2024-01-01"\r\n';
    expect(parseLetterboxdWatchlist(csv)).toEqual([{ title: 'Inception', year: 2010 }]);
  });

  it('refuse un fichier qui n’est pas une liste Letterboxd', () => {
    expect(() => parseLetterboxdWatchlist('Titre,Annee\nMatrix,1999')).toThrowError(/watchlist\.csv/);
  });
});

describe('normalizeTitle', () => {
  it('ignore accents, casse et ponctuation', () => {
    expect(normalizeTitle('  Amélie !')).toBe('amelie');
    expect(normalizeTitle('Spider-Man: No Way Home')).toBe('spider man no way home');
  });
});

describe('matchMovie', () => {
  const found = (tmdbId: number, title: string, year: number | null, originalTitle = title) => ({
    tmdbId,
    type: 'movie' as const,
    title,
    year,
    posterPath: null,
    backdropPath: null,
    overview: '',
    originalTitle,
  });

  it('même titre et même année : trouvé', () => {
    const match = matchMovie({ title: 'The Matrix', year: 1999 }, [
      found(1, 'Matrix Reloaded', 2003),
      found(603, 'The Matrix', 1999),
    ]);
    expect(match).toMatchObject({ tmdbId: 603 });
  });

  it('rapproche le titre original d’un titre français', () => {
    const match = matchMovie({ title: 'Amélie', year: 2001 }, [
      found(194, 'Le Fabuleux Destin d’Amélie Poulain', 2001, 'Amélie'),
    ]);
    expect(match).toMatchObject({ tmdbId: 194 });
  });

  it('année décalée d’un an : trouvé, si aucun film n’a l’année exacte', () => {
    expect(matchMovie({ title: 'Parasite', year: 2019 }, [found(496243, 'Parasite', 2020)])).toMatchObject({
      tmdbId: 496243,
    });
    // l'année exacte l'emporte sur l'année voisine
    expect(
      matchMovie({ title: 'Parasite', year: 2019 }, [found(1, 'Parasite', 2020), found(2, 'Parasite', 2019)]),
    ).toMatchObject({ tmdbId: 2 });
  });

  it('année absente : un seul film du même titre suffit', () => {
    expect(matchMovie({ title: 'Heat', year: null }, [found(949, 'Heat', 1995)])).toMatchObject({ tmdbId: 949 });
  });

  it('plusieurs films de même titre et même année : ambigu', () => {
    expect(matchMovie({ title: 'Heat', year: 1995 }, [found(1, 'Heat', 1995), found(2, 'Heat', 1995)])).toBe(
      'ambiguous',
    );
  });

  it('des résultats sans titre ou année concordants : ambigu ; aucun résultat : introuvable', () => {
    expect(matchMovie({ title: 'Heat', year: 1995 }, [found(1, 'Chaleur', 1995)])).toBe('ambiguous');
    expect(matchMovie({ title: 'Heat', year: 1995 }, [found(1, 'Heat', 2010)])).toBe('ambiguous');
    expect(matchMovie({ title: 'Heat', year: 1995 }, [])).toBe('not_found');
  });
});
