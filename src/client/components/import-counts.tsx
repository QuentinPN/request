/** Comptes d'un aperçu ou d'un import (Seerr, liste externe) : une tuile par ligne, dans la grille `className`. */
export function ImportCounts({ rows, className }: { rows: Array<[string, number]>; className: string }) {
  return (
    <dl className={className}>
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 rounded-[12px] bg-muted px-3 py-2.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
