import type { MaskedSetting, SettingInput } from '@shared/settings.ts';
import { TRAKT_SETTINGS_PATH } from '@shared/watchlist.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { apiSend } from '@/lib/http';
import { traktQuery } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

function TraktForm({ stored, ...frame }: SectionFrameProps & { stored: MaskedSetting<'trakt'> }) {
  const id = useId();
  const queryClient = useQueryClient();
  // Vide : garder le Client ID enregistré (il ne revient jamais du serveur).
  const [clientId, setClientId] = useState('');
  const save = useMutation({
    mutationFn: (value: SettingInput<'trakt'>) => apiSend<MaskedSetting<'trakt'>>('PUT', TRAKT_SETTINGS_PATH, value),
    onSuccess: (saved) => {
      queryClient.setQueryData(traktQuery.queryKey, saved);
      setClientId('');
    },
  });

  const typed = clientId.trim();
  const canSave = typed !== '' && !save.isPending;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) save.mutate({ clientId: typed });
  };

  const status = sectionStatus({
    saved: stored.clientId.set,
    open: false,
    failed: save.isError,
    testing: save.isPending,
  });

  return (
    <SectionFrame {...frame} status={status} doneLabel="Actif" todoLabel="Désactivé">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Permet aux membres d’importer leur liste de souhaits Trakt dans « Ma liste ». L’import de Letterboxd, lui, n’a
          besoin d’aucun réglage.
        </p>
        <div>
          <Label htmlFor={`${id}-client`}>Client ID de l’application Trakt</Label>
          <Input
            id={`${id}-client`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={stored.clientId.set ? 'Client ID enregistré' : undefined}
            aria-describedby={`${id}-client-hint`}
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              save.reset();
            }}
          />
          <FieldHint id={`${id}-client-hint`}>
            {stored.clientId.set
              ? 'Enregistré et chiffré : laissez vide pour le garder, ou collez-en un nouveau.'
              : 'trakt.tv › Paramètres › Your API Apps › New Application : copiez son Client ID. L’adresse de redirection demandée n’est pas utilisée : urn:ietf:wg:oauth:2.0:oob convient.'}
          </FieldHint>
        </div>
        <div role="status" className="empty:hidden">
          {save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : save.isSuccess ? (
            <Notice tone="ok">Client ID Trakt enregistré</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button type="submit" size="lg" className={actionClass} disabled={!canSave}>
            {save.isPending ? 'Vérification…' : 'Enregistrer'}
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}

/** Listes externes (propriétaire) : Client ID Trakt, facultatif, hors de l'assistant. Il est vérifié avant d'être gardé. */
export function TraktSection(frame: SectionFrameProps) {
  const query = useQuery(traktQuery);

  if (query.isPending)
    return (
      <SectionFrame {...frame} status="todo" todoLabel="Désactivé">
        <div role="status" className="space-y-4">
          <span className="sr-only">Chargement…</span>
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
        </div>
      </SectionFrame>
    );
  if (query.isError)
    return (
      <SectionFrame {...frame} status="error">
        <ErrorState message="Ce réglage n’a pas pu se charger." onRetry={() => void query.refetch()} />
      </SectionFrame>
    );
  return <TraktForm {...frame} stored={query.data} />;
}
