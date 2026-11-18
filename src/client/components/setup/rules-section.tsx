import { type QuotaRule, quotaRuleSchema } from '@shared/roles.ts';
import type { MaskedSetting, Setting } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { CheckboxRow, FieldHint, Input, Label } from '@/components/ui/field';
import { discoverSettingQuery, useSaveDiscoverSetting } from '@/lib/blocklist';
import { useSaveSetting } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

const quotas = [
  { key: 'movies', legend: 'Films', unit: 'films' },
  { key: 'seasons', legend: 'Saisons de séries', unit: 'saisons' },
] as const;
type QuotaKey = (typeof quotas)[number]['key'];
type Draft = Record<QuotaKey, { limit: string; days: string }>;

const draftOf = (rule: QuotaRule) => ({ limit: String(rule.limit), days: String(rule.days) });
const ruleOf = (d: { limit: string; days: string }) =>
  // Champ vide : NaN, refusé (et non 0).
  quotaRuleSchema.safeParse({ limit: Number(d.limit || Number.NaN), days: Number(d.days || Number.NaN) });

type Props = SectionFrameProps & {
  stored: MaskedSetting<'rules'>;
  saved: boolean;
  wizard: boolean;
  onSaved: () => void;
};

/** Quotas par défaut des membres, sur une fenêtre glissante (le rôle décide de l'approbation automatique). */
export function RulesSection({ stored, saved, wizard, onSaved, ...frame }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => ({
    movies: draftOf(stored.defaultQuota.movies),
    seasons: draftOf(stored.defaultQuota.seasons),
  }));
  const save = useSaveSetting('rules', onSaved);
  // Réglages seulement (pas l'assistant) : « Masquer dans Découvrir », enregistré avec les quotas.
  const discover = useQuery({ ...discoverSettingQuery, enabled: !wizard });
  const saveDiscover = useSaveDiscoverSetting();
  const [hide, setHide] = useState<Setting<'discover'> | null>(null);
  const hideValue = hide ?? discover.data;
  const parsed = { movies: ruleOf(draft.movies), seasons: ruleOf(draft.seasons) };
  const invalid = !parsed.movies.success || !parsed.seasons.success;

  const update = (key: QuotaKey, field: 'limit' | 'days', value: string) => {
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
    save.reset();
  };
  const updateHide = (patch: Partial<Setting<'discover'>>) => {
    if (hideValue) setHide({ ...hideValue, ...patch });
    save.reset();
    saveDiscover.reset();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.movies.success || !parsed.seasons.success) return;
    save.mutate({ defaultQuota: { movies: parsed.movies.data, seasons: parsed.seasons.data } });
    if (hide) saveDiscover.mutate(hide, { onSuccess: () => setHide(null) });
  };

  const failed = save.isError || saveDiscover.isError;
  const pending = save.isPending || saveDiscover.isPending;
  const status = sectionStatus({ saved, open: frame.open, failed, testing: pending });

  return (
    <SectionFrame {...frame} status={status} doneLabel="Enregistré">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {quotas.map(({ key, legend, unit }) => (
            <fieldset key={key} className="grid grid-cols-2 gap-3">
              <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
              <div>
                <Label htmlFor={`${id}-${key}-limit`} className="font-normal text-muted-foreground">
                  Nombre de {unit}
                </Label>
                <Input
                  id={`${id}-${key}-limit`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={draft[key].limit}
                  aria-invalid={!parsed[key].success || undefined}
                  onChange={(e) => update(key, 'limit', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`${id}-${key}-days`} className="font-normal text-muted-foreground">
                  Sur (jours)
                </Label>
                <Input
                  id={`${id}-${key}-days`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft[key].days}
                  aria-invalid={!parsed[key].success || undefined}
                  onChange={(e) => update(key, 'days', e.target.value)}
                />
              </div>
            </fieldset>
          ))}
        </div>
        <FieldHint className="-mt-2">
          Par membre, sur une fenêtre glissante. Un quota propre à un membre pourra remplacer ces valeurs.
        </FieldHint>
        {!wizard && (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-semibold">Masquer dans Découvrir</legend>
            {discover.isError ? (
              <Notice tone="error">Ce réglage n’a pas pu se charger.</Notice>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <CheckboxRow
                  checked={hideValue?.hideAvailable ?? false}
                  disabled={!hideValue}
                  onChange={(hideAvailable) => updateHide({ hideAvailable })}
                  label="Titres disponibles"
                  hint="Déjà dans la bibliothèque (version standard)"
                />
                <CheckboxRow
                  checked={hideValue?.hideRequested ?? false}
                  disabled={!hideValue}
                  onChange={(hideRequested) => updateHide({ hideRequested })}
                  label="Titres déjà demandés"
                  hint="Demande en cours ou téléchargement, 4K comprise"
                />
              </div>
            )}
            <FieldHint className="mt-0">
              Pour tous, dans les rangées de Découvrir seulement : la recherche et les fiches les montrent toujours.
            </FieldHint>
          </fieldset>
        )}
        <div role="status" className="empty:-mt-4">
          {invalid ? (
            <Notice tone="error">Nombres entiers attendus : au moins 0 demande, sur au moins 1 jour.</Notice>
          ) : save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : saveDiscover.isError ? (
            <Notice tone="error">{saveDiscover.error.message}</Notice>
          ) : save.isSuccess && !saveDiscover.isPending && !wizard ? (
            <Notice tone="ok">Règles enregistrées</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button type="submit" size="lg" className={actionClass} disabled={invalid || pending}>
            {wizard ? 'Enregistrer et continuer' : 'Enregistrer'}
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}
