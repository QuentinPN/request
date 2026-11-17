import {
  type ImportSource,
  LETTERBOXD_MAX_BYTES,
  LETTERBOXD_MAX_ROWS,
  skipReasonLabels,
  traktUsernameSchema,
  type WatchlistImportResult,
} from '@shared/watchlist.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Notice } from '@/components/notice';
import { bottomSheet } from '@/components/requests/request-sheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { plural } from '@/lib/catalogue';
import { importWatchlist, watchlistKeys } from '@/lib/watchlist';

const sourceLabels: Record<ImportSource, string> = { trakt: 'Trakt', letterboxd: 'Letterboxd' };
const titles = (n: number) => plural(n, 'titre', 'titres');

/** Comptes d'un aperçu ou d'un import, puis les titres écartés avec leur raison. */
function ResultSummary({ result }: { result: WatchlistImportResult }) {
  const rows: Array<[string, number]> = [
    [result.dryRun ? 'À ajouter' : 'Ajoutés', result.imported],
    ['Déjà dans la liste', result.alreadyInList],
    ['Ignorés', result.skipped.length],
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{titles(result.total)} lus dans la liste.</p>
      {result.truncated && (
        <p className="text-sm text-muted-foreground">Seuls les 2 000 premiers titres sont importés.</p>
      )}
      <dl className="grid grid-cols-3 gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-[12px] bg-muted px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {result.skipped.length > 0 && (
        <div className="text-sm">
          <p className="text-muted-foreground">
            Ces titres ne sont pas importés ; vous pouvez les chercher et les ajouter depuis leur fiche.
          </p>
          <ul className="mt-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
            {result.skipped.map((item, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe, un même titre peut figurer deux fois
                key={i}
                className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 rounded-[10px] bg-(--surface-2) px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 font-semibold">
                  {item.title}
                  {item.year ? ` (${item.year})` : ''}
                </span>
                <span className="shrink-0 text-muted-foreground">{skipReasonLabels[item.reason]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Ce qui est lu pour l'import : un nom d'utilisateur Trakt valide, ou le contenu du fichier Letterboxd. */
type ImportInput = { source: 'trakt'; username: string } | { source: 'letterboxd'; csv: string };

/**
 * Import d'une liste Trakt ou d'un fichier `watchlist.csv` de Letterboxd dans « Ma liste » : aperçu (rien n'est
 * écrit), puis import. Toute modification de la saisie invalide l'aperçu : « Importer » porte toujours sur ce qui
 * vient d'être prévisualisé.
 */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ImportSource>('trakt');
  const [username, setUsername] = useState('');
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [imported, setImported] = useState<WatchlistImportResult | null>(null);

  const run = useMutation({
    mutationFn: ({ input, dryRun }: { input: ImportInput; dryRun: boolean }) =>
      importWatchlist(
        input.source,
        input.source === 'trakt' ? { username: input.username } : { csv: input.csv },
        dryRun,
      ),
    onSuccess: (result) => {
      if (result.dryRun) return;
      setImported(result);
      void queryClient.invalidateQueries({ queryKey: watchlistKeys.list });
    },
  });
  const reset = () => {
    run.reset();
    setImported(null);
    setInputError(null);
  };

  /** Saisie prête à envoyer, ou le message qui dit ce qui manque. */
  const readInput = (): ImportInput | string => {
    if (source === 'trakt') {
      const parsed = traktUsernameSchema.safeParse(username);
      return parsed.success ? { source, username: parsed.data } : 'Nom d’utilisateur Trakt invalide';
    }
    return file ? { source, csv: file.csv } : 'Choisissez le fichier watchlist.csv';
  };
  const input = readInput();

  const onFile = async (chosen: File | undefined) => {
    reset();
    setFile(null);
    if (!chosen) return;
    if (chosen.size > LETTERBOXD_MAX_BYTES)
      return setInputError(`Fichier trop volumineux : ${LETTERBOXD_MAX_BYTES / 1024} Ko au plus.`);
    setFile({ name: chosen.name, csv: await chosen.text() });
  };

  const preview = (event: FormEvent) => {
    event.preventDefault();
    if (typeof input === 'string') return setInputError(input);
    reset();
    run.mutate({ input, dryRun: true });
  };

  const previewed = run.isSuccess && run.data.dryRun ? run.data : null;
  const error = inputError ?? (run.isError ? run.error.message : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={bottomSheet}>
        <DialogHeader>
          <DialogTitle>Importer une liste</DialogTitle>
          <DialogDescription>
            Reprend une liste de souhaits Trakt ou Letterboxd dans Ma liste. Relancer l’import n’ajoute aucun doublon.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={preview} className="flex flex-col gap-4">
          <ChipGroup label="Source">
            {(['trakt', 'letterboxd'] as const).map((s) => (
              <FilterChip
                key={s}
                pressed={source === s}
                onClick={() => {
                  setSource(s);
                  reset();
                }}
              >
                {sourceLabels[s]}
              </FilterChip>
            ))}
          </ChipGroup>
          {source === 'trakt' ? (
            <div>
              <Label htmlFor={`${id}-trakt`}>Nom d’utilisateur Trakt</Label>
              <Input
                id={`${id}-trakt`}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${id}-trakt-hint`}
                aria-invalid={inputError ? true : undefined}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  reset();
                }}
              />
              <FieldHint id={`${id}-trakt-hint`}>
                Sa liste de souhaits doit être publique (Trakt › Paramètres › Confidentialité).
              </FieldHint>
            </div>
          ) : (
            <div>
              <Label htmlFor={`${id}-csv`}>Fichier watchlist.csv</Label>
              <Input
                id={`${id}-csv`}
                type="file"
                accept=".csv,text/csv"
                aria-describedby={`${id}-csv-hint`}
                aria-invalid={inputError ? true : undefined}
                className="h-auto py-3"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <FieldHint id={`${id}-csv-hint`}>
                Letterboxd › Réglages › Import & export › Exporter vos données : le fichier se trouve dans l’archive.
                {` ${LETTERBOXD_MAX_ROWS} films au plus.`}
              </FieldHint>
            </div>
          )}
          <div role="status" className="empty:hidden">
            {error ? (
              <Notice tone="error">{error}</Notice>
            ) : imported ? (
              <div className="flex flex-col gap-3">
                <Notice tone="ok">
                  Import terminé : {plural(imported.imported, 'titre ajouté', 'titres ajoutés')} à votre liste.
                </Notice>
                <ResultSummary result={imported} />
              </div>
            ) : previewed ? (
              <div className="flex flex-col gap-3">
                <Notice tone="info">Aperçu : rien n’a encore été ajouté.</Notice>
                <ResultSummary result={previewed} />
              </div>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
              {imported ? 'Terminer' : 'Annuler'}
            </Button>
            <Button
              type="submit"
              size="lg"
              variant={previewed && previewed.imported > 0 ? 'secondary' : 'default'}
              disabled={run.isPending}
            >
              {run.isPending && run.variables?.dryRun ? 'Lecture…' : 'Prévisualiser'}
            </Button>
            {previewed && previewed.imported > 0 && typeof input !== 'string' && (
              <Button
                type="button"
                size="lg"
                disabled={run.isPending}
                onClick={() => run.mutate({ input, dryRun: false })}
              >
                {run.isPending ? 'Import en cours…' : `Importer ${titles(previewed.imported)}`}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
