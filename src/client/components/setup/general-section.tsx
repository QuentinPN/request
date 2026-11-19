import { APP_TITLE_MAX, appTitleSchema, DEFAULT_APP_TITLE } from '@shared/app-info.ts';
import type { Setting } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { generalQuery, useSaveGeneral } from './queries';
import {
  actionClass,
  LoadedSection,
  SectionActions,
  SectionFrame,
  type SectionFrameProps,
  sectionStatus,
} from './section-frame';

function GeneralForm({ stored, ...frame }: SectionFrameProps & { stored: Setting<'general'> }) {
  const id = useId();
  const [title, setTitle] = useState(stored.appTitle);
  const save = useSaveGeneral();

  const parsed = appTitleSchema.safeParse(title);
  const error = parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
  const canSave = parsed.success && parsed.data !== stored.appTitle && !save.isPending;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.success && canSave)
      save.mutate({ appTitle: parsed.data }, { onSuccess: (saved) => setTitle(saved.appTitle) });
  };

  const status = sectionStatus({
    saved: stored.appTitle !== DEFAULT_APP_TITLE,
    open: false,
    failed: save.isError,
    testing: save.isPending,
  });
  const showError = title !== '' && error !== null;

  return (
    <SectionFrame {...frame} status={status} doneLabel="Personnalisé" todoLabel="Par défaut">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <Label htmlFor={`${id}-title`}>Titre de l’application</Label>
          <Input
            id={`${id}-title`}
            autoComplete="off"
            placeholder={DEFAULT_APP_TITLE}
            aria-invalid={showError || undefined}
            aria-describedby={`${id}-title-hint`}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              save.reset();
            }}
          />
          <FieldHint id={`${id}-title-hint`}>
            {showError
              ? error
              : `Affiché dans l’onglet du navigateur, les courriels et les messages d’essai (${APP_TITLE_MAX} caractères au plus). Le logo ne change pas.`}
          </FieldHint>
        </div>
        <div role="status" className="empty:hidden">
          {save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : save.isSuccess ? (
            <Notice tone="ok">Titre enregistré</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button type="submit" size="lg" className={actionClass} disabled={!canSave}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}

/** Réglages › Général (propriétaire) : le titre de l'application, hors de l'assistant. */
export function GeneralSection(frame: SectionFrameProps) {
  const query = useQuery(generalQuery);
  return (
    <LoadedSection
      {...frame}
      todoLabel="Par défaut"
      query={query}
      rows={1}
      errorMessage="Ce réglage n’a pas pu se charger."
    >
      {(stored) => <GeneralForm {...frame} stored={stored} />}
    </LoadedSection>
  );
}
