import { type AgentKey, agentSettingsPath, agentTestPath } from '@shared/agents.ts';
import { type AgentEventKind, agentEventKinds, type NotificationKind } from '@shared/notifications.ts';
import type { MaskedSetting, SettingInput } from '@shared/settings.ts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ComponentProps, type FormEvent, type ReactNode, useId, useState } from 'react';
import type { z } from 'zod';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { CheckboxField, FieldHint, Input, Label } from '@/components/ui/field';
import { apiSend } from '@/lib/http';
import { useMediaServerName } from '@/lib/media-server';
import { eventLabels } from './config';
import { agentQuery } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

/** `kind` coché ou décoché dans `current`, le reste dans l'ordre de `all`. */
export const toggleKind = <T extends string>(all: readonly T[], current: readonly T[], kind: T, on: boolean) =>
  all.filter((k) => (k === kind ? on : current.includes(k)));

/** Cases à cocher des types de notification d'un canal (agents, courriel) : libellés de `eventLabels`. */
export function EventsFieldset<T extends AgentEventKind | NotificationKind>({
  legend,
  kinds,
  selected,
  onToggle,
  hint,
}: {
  legend: string;
  kinds: readonly T[];
  selected: readonly T[];
  onToggle: (kind: T, on: boolean) => void;
  hint?: string;
}) {
  const labels = eventLabels(useMediaServerName());
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {kinds.map((kind) => (
          <CheckboxField
            key={kind}
            checked={selected.includes(kind)}
            onChange={(e) => onToggle(kind, e.target.checked)}
          >
            {labels[kind]}
          </CheckboxField>
        ))}
      </div>
      {hint && <FieldHint>{hint}</FieldHint>}
    </fieldset>
  );
}

/** Message d'erreur d'une saisie d'après le schéma de son champ ; une saisie vide n'est jamais une erreur. */
export const fieldError = (schema: z.ZodType, value: string): string | null =>
  value.trim() === '' ? null : (schema.safeParse(value.trim()).error?.issues[0]?.message ?? null);

/** Champ de formulaire d'un agent : libellé, saisie, et l'aide ou, à sa place, l'erreur. */
export function AgentInput({
  label,
  hint,
  error,
  className,
  ...input
}: ComponentProps<'input'> & { label: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={note ? `${id}-hint` : undefined}
        aria-invalid={error ? true : undefined}
        {...input}
      />
      {note && (
        <FieldHint id={`${id}-hint`} className={error ? 'text-(--text-danger)' : undefined}>
          {note}
        </FieldHint>
      )}
    </div>
  );
}

/**
 * État d'un formulaire d'agent : activé, évènements choisis, enregistrement et essai. `edit` enveloppe chaque
 * modification (efface les avis précédents) ; `onSaved` vide les champs secrets, que le serveur ne renvoie jamais.
 */
export function useAgentForm<K extends AgentKey>(
  key: K,
  stored: { enabled: boolean; events: AgentEventKind[] },
  onSaved: () => void,
) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(stored.enabled);
  const [events, setEvents] = useState<AgentEventKind[]>(stored.events);
  const save = useMutation({
    mutationFn: (value: SettingInput<K>) => apiSend<MaskedSetting<K>>('PUT', agentSettingsPath(key), value),
    onSuccess: (saved) => {
      queryClient.setQueryData(agentQuery(key).queryKey, saved);
      onSaved();
    },
  });
  const test = useMutation({
    mutationFn: (value: object) => apiSend<{ ok: true }>('POST', agentTestPath(key), value),
  });
  const edit = (change: () => void) => {
    change();
    save.reset();
    test.reset();
  };
  return {
    enabled,
    events,
    save,
    test,
    edit,
    setEnabled: (on: boolean) => edit(() => setEnabled(on)),
    toggleEvent: (kind: AgentEventKind, on: boolean) =>
      edit(() => setEvents((current) => toggleKind(agentEventKinds, current, kind, on))),
  };
}

type MutationState = { isError: boolean; isSuccess: boolean; isPending: boolean; error: Error | null };
type AgentFormState = {
  enabled: boolean;
  events: readonly AgentEventKind[];
  setEnabled: (on: boolean) => void;
  toggleEvent: (kind: AgentEventKind, on: boolean) => void;
  save: MutationState;
  test: MutationState;
};

/**
 * Section de Réglages d'un agent : la case « activer », ses champs (`children`), les évènements envoyés, « Tester » et
 * « Enregistrer ». `active` : activé et configuré (pastille « Actif »). Le même squelette pour tous les agents.
 */
export function AgentFormView({
  frame,
  form,
  active,
  intro,
  enableLabel,
  savedNotice,
  testNotice,
  canTest,
  canSave,
  onSave,
  onTest,
  children,
}: {
  frame: SectionFrameProps;
  form: AgentFormState;
  active: boolean;
  intro: ReactNode;
  enableLabel: string;
  savedNotice: string;
  testNotice: string;
  canTest: boolean;
  canSave: boolean;
  onSave: () => void;
  onTest: () => void;
  children: ReactNode;
}) {
  const { save, test } = form;
  const status = sectionStatus({
    saved: active,
    // Facultatif : ouvert ou non, il reste « Désactivé » tant qu'il n'est pas actif.
    open: false,
    failed: save.isError || test.isError,
    testing: save.isPending || test.isPending,
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave && !save.isPending) onSave();
  };

  return (
    <SectionFrame {...frame} status={status} doneLabel="Actif" todoLabel="Désactivé">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">{intro}</div>
        <CheckboxField
          className="font-semibold"
          checked={form.enabled}
          onChange={(e) => form.setEnabled(e.target.checked)}
        >
          {enableLabel}
        </CheckboxField>
        {children}
        <EventsFieldset
          legend="Évènements envoyés"
          kinds={agentEventKinds}
          selected={form.events}
          onToggle={form.toggleEvent}
          hint="Un message par évènement, pas un par destinataire."
        />
        <div role="status" className="empty:hidden">
          {save.isError ? (
            <Notice tone="error">{save.error?.message}</Notice>
          ) : test.isError ? (
            <Notice tone="error">{test.error?.message}</Notice>
          ) : save.isSuccess ? (
            <Notice tone="ok">{savedNotice}</Notice>
          ) : test.isSuccess ? (
            <Notice tone="ok">{testNotice}</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className={actionClass}
            disabled={!canTest || test.isPending}
            onClick={onTest}
          >
            {test.isPending ? 'Envoi…' : 'Tester'}
          </Button>
          <Button type="submit" size="lg" className={actionClass} disabled={!canSave || save.isPending}>
            Enregistrer
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}
