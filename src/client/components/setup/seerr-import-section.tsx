import { SEERR_IMPORT_PATH, type SeerrImportInput, type SeerrImportResult } from '@shared/import.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { apiSend } from '@/lib/http';
import { invalidateAfterRequest } from '@/lib/requests';
import { isHttpUrl, URL_ERROR } from './config';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps } from './section-frame';

const importSeerr = (input: SeerrImportInput, dryRun: boolean) =>
  apiSend<SeerrImportResult>('POST', `${SEERR_IMPORT_PATH}${dryRun ? '?dryRun=1' : ''}`, input);

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const requestsLabel = (n: number) => plural(n, 'demande', 'demandes');

/** Comptes d'un aperçu ou d'un import : les mêmes lignes, au futur ou au passé. */
function ResultSummary({ result }: { result: SeerrImportResult }) {
  const skippedForUsers = result.unmatchedUsers.reduce((sum, u) => sum + u.requests, 0);
  const rows: Array<[string, number]> = [
    [result.dryRun ? 'À importer' : 'Importées', result.imported],
    ['Déjà présentes', result.alreadyPresent],
    ['Membres introuvables', skippedForUsers],
    ['Titres non reconnus', result.unmatchedMedia],
    ['Demandes 4K en attente ignorées', result.skipped4k],
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {requestsLabel(result.total)} lue{result.total > 1 ? 's' : ''} dans Seerr.
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-[12px] bg-muted px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {result.unmatchedUsers.length > 0 && (
        <div className="text-sm">
          <p className="text-muted-foreground">
            Sans membre correspondant (même compte Emby ou même nom), leurs demandes sont ignorées. Une fois ces membres
            connectés une première fois à l’appli, relancez l’import : rien ne sera créé en double.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {result.unmatchedUsers.map((u) => (
              <li key={u.seerrId} className="rounded-pill bg-(--surface-2) px-2.5 py-1 text-xs font-semibold">
                {u.name} · {requestsLabel(u.requests)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({
  preview,
  input,
  onClose,
  onDone,
}: {
  preview: SeerrImportResult;
  input: SeerrImportInput;
  onClose: () => void;
  onDone: (result: SeerrImportResult) => void;
}) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => importSeerr(input, false),
    onSuccess: (result) => {
      invalidateAfterRequest(queryClient);
      onDone(result);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !run.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Importer {requestsLabel(preview.imported)} ?</DialogTitle>
          <DialogDescription>
            Elles gardent leur date et leur statut d’origine. Rien n’est envoyé à Radarr ni à Sonarr, aucun membre n’est
            prévenu et les quotas ne sont pas vérifiés.
          </DialogDescription>
        </DialogHeader>
        {run.isError && <Notice tone="error">{run.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Annuler
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? 'Import en cours…' : 'Importer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Import facultatif des demandes de Seerr (propriétaire) : aperçu (rien n'est écrit), puis import confirmé. Adresse et
 * clé ne servent qu'à ces appels : le serveur ne les enregistre pas, la clé est effacée du champ après l'import.
 */
export function SeerrImportSection(frame: SectionFrameProps) {
  const id = useId();
  const [values, setValues] = useState<SeerrImportInput>({ url: '', apiKey: '' });
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [imported, setImported] = useState<SeerrImportResult | null>(null);
  const preview = useMutation({ mutationFn: (input: SeerrImportInput) => importSeerr(input, true) });

  // Toute modification invalide l'aperçu : « Importer » porte toujours sur ce qui vient d'être prévisualisé.
  const edit = (patch: Partial<SeerrImportInput>) => {
    setValues((v) => ({ ...v, ...patch }));
    setCheckError(null);
    setImported(null);
    preview.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const error = !isHttpUrl(values.url) ? URL_ERROR : values.apiKey.trim() ? null : 'Clé d’API requise';
    setCheckError(error);
    setImported(null);
    if (error) preview.reset();
    else preview.mutate({ url: values.url.trim(), apiKey: values.apiKey });
  };

  const canImport = preview.isSuccess && preview.data.imported > 0;
  const failed = Boolean(checkError) || preview.isError;
  const status = failed ? 'error' : imported ? 'done' : preview.isPending || frame.open ? 'active' : 'todo';

  const message = (() => {
    if (checkError) return <Notice tone="error">{checkError}</Notice>;
    if (preview.isError) return <Notice tone="error">{preview.error.message}</Notice>;
    if (imported)
      return (
        <div className="flex flex-col gap-3">
          <Notice tone="ok">Import terminé : {plural(imported.imported, 'demande créée', 'demandes créées')}.</Notice>
          <ResultSummary result={imported} />
        </div>
      );
    if (preview.isSuccess)
      return (
        <div className="flex flex-col gap-3">
          <Notice tone="info">Aperçu : rien n’a encore été importé.</Notice>
          <ResultSummary result={preview.data} />
        </div>
      );
    return null;
  })();

  return (
    <SectionFrame {...frame} status={status} doneLabel="Importé" todoLabel="Facultatif">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Reprend les demandes de Jellyseerr ou d’Overseerr, avec leur date et leur statut. Relancer l’import ne crée
          aucun doublon. L’adresse et la clé ne sont pas enregistrées.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-url`}>Adresse de Seerr</Label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://192.0.2.20:5055"
              value={values.url}
              onChange={(e) => edit({ url: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-key`}>Clé d’API de Seerr</Label>
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-key-hint`}
              value={values.apiKey}
              onChange={(e) => edit({ apiKey: e.target.value })}
            />
            <FieldHint id={`${id}-key-hint`}>Seerr › Paramètres › Général › Clé d’API</FieldHint>
          </div>
        </div>
        <div role="status" className="empty:-mt-4">
          {message}
        </div>
        <SectionActions>
          <Button
            type="submit"
            variant={canImport ? 'secondary' : 'default'}
            size="lg"
            className={actionClass}
            disabled={preview.isPending}
          >
            {preview.isPending ? 'Lecture de Seerr…' : 'Prévisualiser'}
          </Button>
          <Button
            type="button"
            size="lg"
            className={actionClass}
            disabled={!canImport}
            onClick={() => setConfirming(true)}
          >
            Importer
          </Button>
        </SectionActions>
      </form>
      {confirming && preview.data && (
        <ConfirmDialog
          preview={preview.data}
          input={{ url: values.url.trim(), apiKey: values.apiKey }}
          onClose={() => setConfirming(false)}
          onDone={(result) => {
            setConfirming(false);
            preview.reset();
            setValues((v) => ({ ...v, apiKey: '' }));
            setImported(result);
          }}
        />
      )}
    </SectionFrame>
  );
}
