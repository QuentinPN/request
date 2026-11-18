const DELIMITERS = [',', ';', '\t'];

/** Séparateur de la ligne d'en-tête : celui des trois usuels qui y apparaît le plus (virgule par défaut). */
function delimiterOf(text: string): string {
  const header = text.slice(0, text.search(/\r\n|\r|\n|$/));
  return DELIMITERS.reduce(
    (best, d) => (header.split(d).length > header.split(best).length ? d : best),
    DELIMITERS[0] as string,
  );
}

/**
 * Lit un CSV (RFC 4180) en lignes de cellules : BOM ignoré, champs entre guillemets (virgules, sauts de ligne et
 * `""` à l'intérieur), fins de ligne `\r\n`, `\n` ou `\r`, lignes vides écartées.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (c === delimiter) endCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * CSV avec en-tête en objets `{ colonne: valeur }` : colonnes reconnues par leur nom (casse et espaces ignorés), dans
 * n'importe quel ordre ; une colonne absente d'une ligne courte vaut `''`.
 */
export function parseCsvRecords(input: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(input);
  if (!header) return [];
  const names = header.map((name) => name.trim().toLowerCase());
  return rows.map((cells) => Object.fromEntries(names.map((name, i) => [name, (cells[i] ?? '').trim()])));
}
