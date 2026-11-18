import { cn } from 'cn';
import type { ReactNode } from 'react';
import { formatCount, monthName, percentOf } from '@/lib/stats';

// Graphiques de la page Statistiques : CSS et HTML, sans bibliothèque. Une seule teinte (la marque) pour une série ;
// le texte reste en encre de texte, la couleur ne porte jamais seule l'identité. Chaque graphique a son tableau.

const MIN_BAR = 'min-h-0.5';

/** Une valeur de graphique en ligne de tableau (libellé, effectif). */
export type ChartRow = { label: string; value: number };

/** Tableau équivalent du graphique, replié : lecteurs d'écran et personnes qui veulent les chiffres exacts. */
export function ChartTable({ caption, head, rows }: { caption: string; head: [string, string]; rows: ChartRow[] }) {
  return (
    <details className="group text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring">
        Voir les chiffres
      </summary>
      <table className="mt-1 w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {head[0]}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {head[1]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="py-1.5 pr-4 font-normal">
                {row.label}
              </th>
              <td className="py-1.5 text-right tabular-nums">{formatCount(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Cadre d'un graphique : titre, légende de lecture, graphique, tableau. */
export function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn('space-y-4 rounded-card bg-card p-5 ring-1 ring-border', className)}>
      <figcaption className="space-y-1">
        <span className="block text-base font-semibold">{title}</span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </figcaption>
      {children}
    </figure>
  );
}

/** Histogramme des 12 mois : une barre par mois, effectif lu au survol, au focus et pour les extrêmes. */
export function MonthHistogram({ months }: { months: Array<{ month: string; count: number }> }) {
  const peak = Math.max(...months.map((m) => m.count), 0);
  const last = months.length - 1;
  return (
    <>
      <ol className="flex h-44 items-end gap-1 border-b border-(--border-2) sm:gap-2" aria-label="Demandes par mois">
        {months.map((m, i) => {
          const labelled = m.count > 0 && (m.count === peak || i === last);
          return (
            <li
              key={m.month}
              title={`${monthName(m.month, 'long')} : ${formatCount(m.count)}`}
              className="group/bar relative flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              <span
                className={cn(
                  'pb-1 text-center text-xs font-medium text-foreground tabular-nums',
                  labelled ? '' : 'opacity-0 transition-opacity duration-(--dur) group-hover/bar:opacity-100',
                )}
                aria-hidden
              >
                {formatCount(m.count)}
              </span>
              <span
                className={cn('block rounded-t-sm bg-brand', m.count > 0 && MIN_BAR)}
                style={{ height: peak === 0 ? 0 : `${(m.count / peak) * 85}%` }}
              />
            </li>
          );
        })}
      </ol>
      <ol aria-hidden className="flex gap-1 text-xs text-muted-foreground sm:gap-2">
        {months.map((m) => (
          <li key={m.month} className="min-w-0 flex-1 text-center">
            <span className="sm:hidden">{monthName(m.month, 'narrow')}</span>
            <span className="hidden sm:inline">{monthName(m.month, 'short')}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Classement en barres horizontales, la plus longue à la taille du plus grand effectif. */
export function RankedBars({
  rows,
  label,
  empty,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number; lead?: ReactNode }>;
  label: string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const peak = Math.max(...rows.map((r) => r.value));
  return (
    <ol aria-label={label} className="space-y-3">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3">
          {row.lead}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">{formatCount(row.value)}</span>
            </div>
            <div className="h-2 rounded-pill bg-(--track-soft)">
              <div
                className="h-full rounded-pill bg-brand"
                style={{ width: `${peak === 0 ? 0 : (row.value / peak) * 100}%` }}
              />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Deux parts d'un total (films et séries, HD et 4K) : barre à deux segments séparés d'un filet, légende chiffrée. */
export function SplitBar({ parts }: { parts: [ChartRow, ChartRow] }) {
  const total = parts[0].value + parts[1].value;
  const swatch = ['bg-brand', 'bg-muted-foreground'] as const;
  return (
    <div className="space-y-3">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-pill bg-(--track-soft)" aria-hidden>
        {parts.map((part, i) => (
          <span
            key={part.label}
            className={cn('h-full', swatch[i])}
            style={{ width: `${percentOf(part.value, total)}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {parts.map((part, i) => (
          <li key={part.label} className="flex items-center gap-2">
            <span aria-hidden className={cn('size-2.5 rounded-sm', swatch[i])} />
            <span>{part.label}</span>
            <span className="font-semibold tabular-nums">{formatCount(part.value)}</span>
            <span className="text-muted-foreground tabular-nums">({percentOf(part.value, total)} %)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
